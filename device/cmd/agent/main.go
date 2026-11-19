// node-agent：跑在盒子 / Windows / 任意 Linux 上，主动出站连 core 的 wss，接收并执行命令。
//
//	node-agent -server wss://your-host.example/dev/ws -token <TOKEN> -root /var/agent/work
//	node-agent -config agent.json          # 同上，但 token 不落在命令行（ps 看不见）
//
// 设计约束（对齐 files/print/agent）：
//   - 只出站，服务器不需要任何入站端口
//   - 断线指数退避重连，半开连接靠读超时兜底
//   - 单机不依赖 Node / 不装运行时，一个二进制跑起来
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"agent-device/pkg/proto"
	"agent-device/pkg/wsnode"
)

const version = "0.1.0"

var (
	maxOutBytes = int64(4 << 20) // 单条命令回传上限，超出截断并标记
	maxParallel = 4              // 同机并发执行数
)

type proc struct {
	cmd *exec.Cmd
	mu  sync.Mutex
	kln string // 终止原因：cancelled / timeout
}

func (p *proc) kill(reason string) {
	p.mu.Lock()
	if p.kln == "" {
		p.kln = reason
	}
	p.mu.Unlock()
	killProc(p.cmd)
}

func (p *proc) killed() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.kln
}

// fileConfig 是 -config 读的 JSON，字段全部可选：没写的落到命令行/默认值。
// 之所以需要它：token 写在命令行会被 ps 看见。
type fileConfig struct {
	Server   string `json:"server"`
	Token    string `json:"token"`
	Root     string `json:"root"`
	Name     string `json:"name"`
	Shell    string `json:"shell"`
	Insecure *bool  `json:"insecure"`
}

var startedAt = time.Now()

type runner struct {
	conn  *wsnode.Conn
	root  string
	shell string
	sem   chan struct{}

	mu    sync.Mutex
	procs map[string]*proc
}

func main() {
	server := flag.String("server", "", "core 的接入地址，如 wss://your-host.example/dev/ws")
	token := flag.String("token", "", "Bearer token（或环境变量 NODE_TOKEN，或写在 -config 里）")
	root := flag.String("root", "", "工作根目录（默认 ~/agent-work），命令的 cwd 必须落在它之内")
	shellName := flag.String("shell", "", "sh | cmd | powershell（默认按平台）")
	name := flag.String("name", "", "设备名（默认 hostname）")
	configPath := flag.String("config", "", "JSON 配置文件：server/token/root/name/shell/insecure；命令行参数优先于它")
	insecure := flag.Bool("insecure", false, "跳过证书校验")
	fixClock := flag.Bool("fix-clock", false, "证书失败时用服务器时间校准本机（Linux 需 root）")
	flag.Parse()

	// 优先级：命令行显式参数 > 环境变量（仅 token）> 配置文件 > 默认值。
	// 配置文件的意义是把 token 从命令行拿掉——ps aux 能看见所有参数。
	set := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if *configPath != "" {
		var fc fileConfig
		b, err := os.ReadFile(*configPath)
		if err != nil {
			log.Fatalf("读配置失败：%v", err)
		}
		if err := json.Unmarshal(b, &fc); err != nil {
			log.Fatalf("配置 %s 不是合法 JSON：%v", *configPath, err)
		}
		if !set["server"] && fc.Server != "" {
			*server = fc.Server
		}
		if !set["token"] && fc.Token != "" {
			*token = fc.Token
		}
		if !set["root"] && fc.Root != "" {
			*root = fc.Root
		}
		if !set["name"] && fc.Name != "" {
			*name = fc.Name
		}
		if !set["shell"] && fc.Shell != "" {
			*shellName = fc.Shell
		}
		if !set["insecure"] && fc.Insecure != nil {
			*insecure = *fc.Insecure
		}
	}
	if *token == "" {
		*token = os.Getenv("NODE_TOKEN")
	}

	if *server == "" {
		log.Fatal("缺少 -server（或配置文件里的 server）")
	}
	if *token == "" {
		log.Fatal("缺少 token：用 -token / NODE_TOKEN / 配置文件")
	}

	r := &runner{
		root:  *root,
		shell: *shellName,
		sem:   make(chan struct{}, maxParallel),
		procs: map[string]*proc{},
	}
	if r.root == "" {
		home, _ := os.UserHomeDir()
		r.root = filepath.Join(home, "agent-work")
	}
	r.root = filepath.Clean(r.root)
	if err := os.MkdirAll(r.root, 0o755); err != nil {
		log.Fatalf("工作根不可用：%v", err)
	}
	if r.shell == "" {
		r.shell = defaultShell()
	}
	host, _ := os.Hostname()
	if *name != "" {
		host = *name
	}

	log.Printf("node-agent %s 启动：root=%s shell=%s → %s", version, r.root, r.shell, *server)
	shPath, shVer := shellInfo(r.shell)
	log.Printf("shell：%s（%s %s）", r.shell, shPath, shVer)
	cfg := wsnode.Config{URL: *server, Token: *token, Insecure: *insecure, FixClock: *fixClock}
	err := wsnode.Run(context.Background(), cfg,
		func(c *wsnode.Conn) error {
			r.conn = c
			if err := c.Send(proto.Msg{
				T: proto.TKindHello, Ver: version, Name: host,
				OS: runtime.GOOS, Arch: runtime.GOARCH,
				Shell: r.shell, ShellPath: shPath, ShellVer: shVer, Root: r.root,
			}); err != nil {
				return err
			}
			log.Printf("已连上 hub（%s/%s shell=%s %s）", runtime.GOOS, runtime.GOARCH, shPath, shVer)
			return nil
		},
		func(c *wsnode.Conn, t string, raw []byte) {
			var m proto.Msg
			if json.Unmarshal(raw, &m) != nil {
				return
			}
			switch t {
			case proto.TKindExec:
				go r.run(m)
			case proto.TKindKill:
				if p := r.lookup(m.ID); p != nil {
					p.kill("cancelled")
				}
			case proto.TKindPing:
				_ = c.Send(proto.Msg{T: proto.TKindPong})
			case proto.TKindHealth:
				h := hostHealth()
				m := proto.Msg{
					T: proto.TKindHealth, ID: m.ID,
					UptimeSec: int64(time.Since(startedAt).Seconds()), HostUptimeSec: h.HostUptimeSec,
					Load1: h.Load1, Load5: h.Load5, Load15: h.Load15,
					MemTotalMB: h.MemTotalMB, MemFreeMB: h.MemFreeMB,
					DiskTotalGB: h.DiskTotalGB, DiskFreeGB: h.DiskFreeGB, TempC: h.TempC,
					OS: runtime.GOOS, Arch: runtime.GOARCH, Name: host,
				}
				_ = c.Send(m)
			}
		})
	log.Printf("退出：%v", err)
}

func (r *runner) lookup(id string) *proc {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.procs[id]
}

func (r *runner) send(m proto.Msg) { _ = r.conn.Send(m) }

func (r *runner) exit(id string, code int, killed, errMsg string, truncated bool, ms int64) {
	m := proto.Msg{T: proto.TKindExit, ID: id, Code: &code, Killed: killed, Err: errMsg, MS: ms, Truncated: truncated}
	r.send(m)
}

// run 执行一条命令：并发闸门 → cwd 校验 → 起进程组 → 流式回传 → 退出码。
func (r *runner) run(m proto.Msg) {
	select {
	case r.sem <- struct{}{}:
	case <-time.After(30 * time.Second):
		r.exit(m.ID, -1, "", "节点忙：排队超过 30 秒", false, 0)
		return
	}
	defer func() { <-r.sem }()

	dir, err := r.resolveCwd(m.Cwd)
	if err != nil {
		r.exit(m.ID, -1, "", err.Error(), false, 0)
		return
	}
	tmo := time.Duration(m.TimeoutMS) * time.Millisecond
	if tmo <= 0 {
		tmo = 5 * time.Minute
	}

	ctx, cancel := context.WithTimeout(context.Background(), tmo)
	defer cancel()

	sh, shArgs := shellCmd(r.shell)
	cmd := exec.CommandContext(ctx, sh, append(shArgs, m.Cmd)...)
	cmd.Dir = dir
	if len(m.Env) > 0 {
		cmd.Env = append(os.Environ(), flatten(m.Env)...)
	}
	cmd.Cancel = func() error { killProc(cmd); return nil } // 超时/取消时整组杀，不只杀 sh
	setupProc(cmd)

	outPipe, err1 := cmd.StdoutPipe()
	errPipe, err2 := cmd.StderrPipe()
	if err1 != nil || err2 != nil {
		r.exit(m.ID, 127, "", "取管道失败", false, 0)
		return
	}

	p := &proc{cmd: cmd}
	r.mu.Lock()
	r.procs[m.ID] = p
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.procs, m.ID)
		r.mu.Unlock()
	}()

	started := time.Now()
	if err := cmd.Start(); err != nil {
		r.exit(m.ID, 127, "", "启动失败："+err.Error(), false, 0)
		return
	}

	var sent atomic.Int64
	var truncated atomic.Bool
	var wg sync.WaitGroup
	pump := func(rd io.Reader, stream string) {
		defer wg.Done()
		buf := make([]byte, 32<<10)
		for {
			n, rerr := rd.Read(buf)
			if n > 0 {
				if sent.Load() >= maxOutBytes {
					truncated.Store(true)
				} else {
					chunk := make([]byte, n)
					copy(chunk, buf[:n])
					sent.Add(int64(n))
					r.send(proto.Msg{T: proto.TKindChunk, ID: m.ID, Out: stream, Stream: chunk})
				}
			}
			if rerr != nil {
				return
			}
		}
	}
	wg.Add(2)
	go pump(outPipe, "out")
	go pump(errPipe, "err")
	wg.Wait()
	werr := cmd.Wait()

	code := 0
	if werr != nil {
		var ee *exec.ExitError
		if errors.As(werr, &ee) {
			code = ee.ExitCode()
		} else {
			code = 127
		}
	}
	killed := p.killed()
	if killed == "" && ctx.Err() == context.DeadlineExceeded {
		killed = "timeout"
	}
	if killed != "" && code == 0 {
		code = -1
	}
	r.exit(m.ID, code, killed, "", truncated.Load(), time.Since(started).Milliseconds())
}

// resolveCwd：hub 已把服务器路径重写成节点路径，这里只保证落在 root 之内并自动建目录。
func (r *runner) resolveCwd(raw string) (string, error) {
	if raw == "" {
		return r.root, nil
	}
	if !filepath.IsAbs(raw) {
		return "", errors.New("cwd 必须是绝对路径：" + raw)
	}
	cwd := filepath.Clean(raw)
	rel, err := filepath.Rel(r.root, cwd)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("cwd 超出工作根：" + cwd)
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		return "", errors.New("建目录失败：" + err.Error())
	}
	return cwd, nil
}

func flatten(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

func defaultShell() string {
	if runtime.GOOS == "windows" {
		return "cmd"
	}
	return "sh"
}

func shellCmd(name string) (string, []string) {
	switch name {
	case "cmd":
		return "cmd", []string{"/c"}
	case "powershell", "pwsh":
		return name, []string{"-NoProfile", "-NonInteractive", "-Command"}
	default:
		if runtime.GOOS == "windows" {
			return "cmd", []string{"/c"}
		}
		if _, err := os.Stat("/bin/sh"); err == nil {
			return "/bin/sh", []string{"-c"}
		}
		return "sh", []string{"-c"}
	}
}

// shellInfo 探测实际解释器与版本。这是模型写命令的唯一入口，所以路径要解开符号链接
// （/bin/sh 可能是 dash / bash / busybox），版本拿不到就留空（dash、busybox 不支持 --version）。
func shellInfo(name string) (string, string) {
	bin, _ := shellCmd(name)
	p, err := exec.LookPath(bin)
	if err != nil {
		return "", ""
	}
	if real, err := filepath.EvalSymlinks(p); err == nil {
		p = real
	}

	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()

	var out []byte
	switch name {
	case "cmd":
		out, _ = exec.CommandContext(ctx, "cmd", "/c", "ver").Output()
	case "powershell", "pwsh":
		out, _ = exec.CommandContext(ctx, bin, "-NoProfile", "-NonInteractive", "-Command",
			"$PSVersionTable.PSVersion.ToString()").Output()
	default:
		out, _ = exec.CommandContext(ctx, p, "--version").Output()
	}

	ver := ""
	if s := strings.TrimSpace(string(out)); s != "" {
		if i := strings.IndexByte(s, '\n'); i > 0 {
			s = s[:i]
		}
		s = strings.TrimSpace(s)
		if len(s) > 60 {
			s = s[:60] + "…"
		}
		ver = s
	}
	return p, ver
}
