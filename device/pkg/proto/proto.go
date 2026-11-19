// Package proto 定义 hub 与节点之间的消息。一条连接上全是 JSON 文本帧，
// 用 t 字段区分类型；二进制数据（命令输出）走 chunk 字段，encoding/json 自动 base64。
package proto

// 消息类型
const (
	TKindHello = "hello"     // 节点 → hub：上线自报家门
	TKindExec  = "exec"      // hub → 节点：执行一条命令
	TKindKill  = "kill"      // hub → 节点：终止某条命令
	TKindChunk = "chunk"     // 节点 → hub：输出片段
	TKindExit  = "exit"      // 节点 → hub：命令结束
	TKindPing  = "ping"      // hub → 节点：保活
	TKindPong  = "pong"      // 节点 → hub：保活回应
	TKindHealth = "health"   // 双向：hub 要指标 / 节点回指标
)

// Msg 是双向通用信封：不同 t 只用其中一部分字段，其余 omitempty。
type Msg struct {
	T string `json:"t"`

	// hello
	Ver   string   `json:"ver,omitempty"`
	Name  string   `json:"name,omitempty"`
	OS    string   `json:"os,omitempty"`
	Arch  string   `json:"arch,omitempty"`
	Shell     string `json:"shell,omitempty"`      // 逻辑名：sh / cmd / powershell
	ShellPath string `json:"shell_path,omitempty"` // 实际解释器路径（符号链接已解开）
	ShellVer  string `json:"shell_ver,omitempty"`  // 版本首行（拿不到就留空）
	Root      string `json:"root,omitempty"`

	// exec / kill
	ID        string            `json:"id,omitempty"`
	Cmd       string            `json:"cmd,omitempty"`
	Cwd       string            `json:"cwd,omitempty"`
	TimeoutMS int               `json:"timeout_ms,omitempty"`
	Env       map[string]string `json:"env,omitempty"`

	// chunk / exit
	Stream    []byte `json:"chunk,omitempty"` // 原始字节，JSON 里是 base64
	Out       string `json:"out,omitempty"`   // "out" | "err"
	Code      *int   `json:"code,omitempty"`
	Killed    string `json:"killed_by,omitempty"` // cancelled | timeout
	MS        int64  `json:"ms,omitempty"`
	Err       string `json:"err,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`

	// health（hub 请求 / 节点回报共用）
	UptimeSec     int64   `json:"uptime_sec,omitempty"`      // 本进程已运行秒数
	HostUptimeSec int64   `json:"host_uptime_sec,omitempty"` // 主机开机秒数（不支持为 -1）
	Load1         float64 `json:"load1,omitempty"`
	Load5         float64 `json:"load5,omitempty"`
	Load15        float64 `json:"load15,omitempty"`
	MemTotalMB    int64   `json:"mem_total_mb,omitempty"`
	MemFreeMB     int64   `json:"mem_free_mb,omitempty"`
	DiskTotalGB   float64 `json:"disk_total_gb,omitempty"`
	DiskFreeGB    float64 `json:"disk_free_gb,omitempty"`
	TempC         float64 `json:"temp_c,omitempty"`
}
