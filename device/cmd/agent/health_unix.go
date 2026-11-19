//go:build !windows

package main

// 主机指标：Linux 走 /proc，macOS 只取内存总量与磁盘，其余给 -1（不支持的平台别编数据）。

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
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
		// macOS 没有 /proc；内存总量走 sysctl（调用很少，允许 fork 一次）
		if out, err := exec.Command("sysctl", "-n", "hw.memsize").Output(); err == nil {
			if v, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64); err == nil {
				h.MemTotalMB = v / (1 << 20)
			}
		}
	}

	var st syscall.Statfs_t
	if err := syscall.Statfs("/", &st); err == nil {
		h.DiskTotalGB = float64(st.Blocks) * float64(st.Bsize) / (1 << 30)
		h.DiskFreeGB = float64(st.Bavail) * float64(st.Bsize) / (1 << 30)
	}
	return h
}
