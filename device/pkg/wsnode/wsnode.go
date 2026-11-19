// Package wsnode 是「节点主动出站 + 断线重连 + 心跳保活」的最小 WebSocket 基座。
// 语义与 files/print/agent 一致：节点在 NAT 后面也能被驱动，服务器不需要任何入站端口。
package wsnode

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/gorilla/websocket"
)

// ReadTimeout 多久没收到服务器任何消息（含 ping）就认定连接已死。
// hub 每 20s ping 一次，正常情况下永远触发不到；半开连接会在这里超时并触发重连。
const ReadTimeout = 90 * time.Second

type Config struct {
	URL      string // wss://host/ws
	Token    string // Authorization: Bearer <token>
	Insecure bool   // 跳过证书校验（自签环境）
	CAFile   string // 额外信任的 CA
	FixClock bool   // 证书校验失败时用服务器 Date 头校时（盒子无 RTC 时有用）
}

type Conn struct {
	ws  *websocket.Conn
	mu  chan struct{} // 容量 1 的信号量：gorilla 不允许并发写
	cfg Config
}

func (c *Conn) Send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.mu <- struct{}{}
	defer func() { <-c.mu }()
	return c.ws.WriteMessage(websocket.TextMessage, b)
}

func (c *Conn) Close() { _ = c.ws.Close() }

// Wrap 把已升级的底层连接包成 Conn（hub 服务端用；客户端走 Run/Dial）。
func Wrap(ws *websocket.Conn) *Conn {
	ws.SetReadLimit(4 << 20)
	return &Conn{ws: ws, mu: make(chan struct{}, 1)}
}

// Run 持续维持连接：拨号 → onOpen → 读循环 → 断开 → 退避重连，直到 ctx 结束。
func Run(ctx context.Context, cfg Config, onOpen func(*Conn) error, onMsg func(*Conn, string, []byte)) error {
	backoff := time.Second
	for {
		start := time.Now()
		err := once(ctx, cfg, onOpen, onMsg)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// 稳定连过 60s 才把退避重置，避免「连上就断」时疯狂重试
		if time.Since(start) > 60*time.Second {
			backoff = time.Second
		}
		if err != nil {
			log.Printf("连接中断：%v；%s 后重连", err, backoff)
		}
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return ctx.Err()
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func once(ctx context.Context, cfg Config, onOpen func(*Conn) error, onMsg func(*Conn, string, []byte)) error {
	d := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
		TLSClientConfig:  tlsConf(cfg),
		Proxy:            http.ProxyFromEnvironment,
		NetDial: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		}).Dial,
	}
	hdr := http.Header{}
	if cfg.Token != "" {
		hdr.Set("Authorization", "Bearer "+cfg.Token)
	}
	ws, resp, err := d.DialContext(ctx, cfg.URL, hdr)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("%s 拒绝连接：%s", cfg.URL, resp.Status)
		}
		if cfg.FixClock && !cfg.Insecure && isCertErr(err) {
			log.Printf("证书校验失败，可能是系统时间不对（%v），尝试用服务器时间校准", err)
			syncClock(cfg.URL)
		}
		return err
	}
	defer ws.Close()
	ws.SetReadLimit(4 << 20)

	c := &Conn{ws: ws, mu: make(chan struct{}, 1), cfg: cfg}
	if err := onOpen(c); err != nil {
		return err
	}
	for {
		_ = ws.SetReadDeadline(time.Now().Add(ReadTimeout))
		_, data, err := ws.ReadMessage()
		if err != nil {
			return err
		}
		var head struct {
			T string `json:"t"`
		}
		if json.Unmarshal(data, &head) != nil {
			continue
		}
		onMsg(c, head.T, data)
	}
}

func isCertErr(err error) bool {
	for _, k := range []string{"certificate", "x509", "tls:"} {
		if contains(err.Error(), k) {
			return true
		}
	}
	return false
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func tlsConf(cfg Config) *tls.Config {
	t := &tls.Config{InsecureSkipVerify: cfg.Insecure}
	if cfg.CAFile != "" {
		if pem, err := os.ReadFile(cfg.CAFile); err == nil {
			pool := x509.NewCertPool()
			if pool.AppendCertsFromPEM(pem) {
				t.RootCAs = pool
			}
		} else {
			log.Printf("读 CA 失败：%v（忽略）", err)
		}
	}
	return t
}

// syncClock 用服务器 Date 头把本机时间拨回来（只对 Linux 的 date 生效，Windows 一般有 RTC 不需要）。
// 证书本身可能是「因为时间错才失败」，所以这里刻意不校验证书。
func syncClock(rawURL string) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return
	}
	scheme := "http"
	if u.Scheme == "wss" || u.Scheme == "https" {
		scheme = "https"
	}
	req, err := http.NewRequest("HEAD", scheme+"://"+u.Host+"/", nil)
	if err != nil {
		return
	}
	client := &http.Client{
		Timeout:   10 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
	}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("校时请求失败：%v", err)
		return
	}
	defer resp.Body.Close()
	t, err := http.ParseTime(resp.Header.Get("Date"))
	if err != nil {
		log.Printf("服务器 Date 头不可解析：%v", err)
		return
	}
	log.Printf("本地时间偏差约 %s（服务器 %s）", time.Since(t).Truncate(time.Second), t.Format(time.RFC3339))
	if runtime.GOOS == "windows" {
		return
	}
	out, err := exec.Command("date", "-u", "-s", t.UTC().Format("2006-01-02 15:04:05")).CombinedOutput()
	if err != nil {
		log.Printf("设置系统时间失败（需要 root）：%v %s", err, out)
		return
	}
	log.Printf("已校时到 %s", t.UTC().Format(time.RFC3339))
}
