//go:build !windows

package main

// 主机指标：Linux 读 /proc，macOS 调 sysctl / vm_stat（health 调用不频繁，允许 fork）。
// 拿不到的指标给 -1，不编数据。

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type healthInfo struct {
	HostUptimeSec int64
	Load1, Load5, Load15 float64
	MemTotalMB, MemFreeMB int64
	DiskTotalGB, DiskFreeGB float64
	TempC float64
}

func hostHealth() healthInfo {
	h := healthInfo{
		HostUptimeSec: -1, Load1: -1, Load5: -1, Load15: -1,
		MemTotalMB: -1, MemFreeMB: -1, DiskTotalGB: -1, DiskFreeGB: -1, TempC: -1,
	}

	switch runtime.GOOS {
	case "linux":
		if b, err := os.ReadFile("/proc/uptime"); err == nil {
			if f := strings.Fields(string(b)); len(f) > 0 {
				if v, err := strconv.ParseFloat(f[0], 64); err == nil {
					h.HostUptimeSec = int64(v)
				}
			}
		}
		if b, err := os.ReadFile("/proc/loadavg"); err == nil {
			if f := strings.Fields(string(b)); len(f) >= 3 {
				h.Load1, _ = strconv.ParseFloat(f[0], 64)
				h.Load5, _ = strconv.ParseFloat(f[1], 64)
				h.Load15, _ = strconv.ParseFloat(f[2], 64)
			}
		}
		if b, err := os.ReadFile("/proc/meminfo"); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				f := strings.Fields(line)
				if len(f) < 2 {
					continue
				}
				kb, _ := strconv.ParseInt(f[1], 10, 64)
				switch f[0] {
				case "MemTotal:":
					h.MemTotalMB = kb / 1024
				case "MemAvailable:":
					h.MemFreeMB = kb / 1024
				}
			}
		}
		if b, err := os.ReadFile("/sys/class/thermal/thermal_zone0/temp"); err == nil {
			if v, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64); err == nil {
				h.TempC = v / 1000
			}
		}
	case "darwin":
		// macOS 没有 /proc，走 sysctl / vm_stat；每次 health 只 fork 三四个进程，频率极低
		if v, err := sysctlValue("hw.memsize"); err == nil {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				h.MemTotalMB = n >> 20
			}
		}
		// 开机时长：kern.boottime 形如 { sec = 1794298276, usec = 155984 } Tue Nov 10 …
		if v, err := sysctlValue("kern.boottime"); err == nil {
			if i := strings.Index(v, "sec = "); i >= 0 {
				rest := v[i+6:]
				if j := strings.IndexAny(rest, ",}"); j > 0 {
					if sec, err := strconv.ParseInt(strings.TrimSpace(rest[:j]), 10, 64); err == nil {
						h.HostUptimeSec = time.Now().Unix() - sec
					}
				}
			}
		}
		// 负载：vm.loadavg 形如 { 1.11 1.40 1.59 }
		if v, err := sysctlValue("vm.loadavg"); err == nil {
			f := strings.FieldsFunc(v, func(r rune) bool { return r == '{' || r == '}' || r == ' ' })
			if len(f) >= 3 {
				h.Load1, _ = strconv.ParseFloat(f[0], 64)
				h.Load5, _ = strconv.ParseFloat(f[1], 64)
				h.Load15, _ = strconv.ParseFloat(f[2], 64)
			}
		}
		// 可用内存 ≈ free + inactive + speculative：macOS 上只看 free 会小得吓人（大半是缓存）
		if mb := darwinAvailableMB(); mb >= 0 {
			h.MemFreeMB = mb
		}
	}

	var st syscall.Statfs_t
	if err := syscall.Statfs("/", &st); err == nil {
		h.DiskTotalGB = float64(st.Blocks) * float64(st.Bsize) / (1 << 30)
		h.DiskFreeGB = float64(st.Bavail) * float64(st.Bsize) / (1 << 30)
	}
	return h
}

// sysctlValue 读一个 sysctl 键，1s 超时兜底。
func sysctlValue(key string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "sysctl", "-n", key).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// darwinAvailableMB 解析 vm_stat，返回 free+inactive+speculative 的 MB 数；解析失败给 -1。
func darwinAvailableMB() int64 {
	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "vm_stat").Output()
	if err != nil {
		return -1
	}
	pageSize := int64(4096)
	free, inactive, speculative := int64(-1), int64(0), int64(0)
	for _, line := range strings.Split(string(out), "\n") {
		if i := strings.Index(line, "page size of "); i >= 0 {
			rest := line[i+len("page size of "):]
			if j := strings.Index(rest, " bytes"); j > 0 {
				if v, err := strconv.ParseInt(rest[:j], 10, 64); err == nil {
					pageSize = v
				}
			}
			continue
		}
		num := func(prefix string) (int64, bool) {
			if !strings.HasPrefix(line, prefix) {
				return 0, false
			}
			v, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimSpace(line[len(prefix):]), "."), 10, 64)
			return v, err == nil
		}
		if v, ok := num("Pages free:"); ok {
			free = v
		}
		if v, ok := num("Pages inactive:"); ok {
			inactive = v
		}
		if v, ok := num("Pages speculative:"); ok {
			speculative = v
		}
	}
	if free < 0 {
		return -1
	}
	return (free + inactive + speculative) * pageSize / (1 << 20)
}
