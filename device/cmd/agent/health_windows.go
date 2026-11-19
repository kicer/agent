//go:build windows

package main

// Windows 指标：GetTickCount64（开机时长）+ GlobalMemoryStatusEx + GetDiskFreeSpaceExW。
// 负载/温度在 Windows 上没有等价指标，返回 -1。

import (
	"syscall"
	"unsafe"
)

type healthInfo struct {
	HostUptimeSec int64
	Load1, Load5, Load15 float64
	MemTotalMB, MemFreeMB int64
	DiskTotalGB, DiskFreeGB float64
	TempC float64
}

var (
	kernel32  = syscall.NewLazyDLL("kernel32.dll")
	procTick  = kernel32.NewProc("GetTickCount64")
	procMem   = kernel32.NewProc("GlobalMemoryStatusEx")
	procDiskF = kernel32.NewProc("GetDiskFreeSpaceExW")
)

type memStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

func hostHealth() healthInfo {
	h := healthInfo{
		HostUptimeSec: -1, Load1: -1, Load5: -1, Load15: -1,
		MemTotalMB: -1, MemFreeMB: -1, DiskTotalGB: -1, DiskFreeGB: -1, TempC: -1,
	}
	if r, _, _ := procTick.Call(); r != 0 {
		h.HostUptimeSec = int64(r / 1000)
	}
	var m memStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	if r, _, _ := procMem.Call(uintptr(unsafe.Pointer(&m))); r != 0 {
		h.MemTotalMB = int64(m.TotalPhys >> 20)
		h.MemFreeMB = int64(m.AvailPhys >> 20)
	}
	if p, err := syscall.UTF16PtrFromString("C:\\"); err == nil {
		var free, total, totalFree uint64
		if r, _, _ := procDiskF.Call(
			uintptr(unsafe.Pointer(p)),
			uintptr(unsafe.Pointer(&free)),
			uintptr(unsafe.Pointer(&total)),
			uintptr(unsafe.Pointer(&totalFree)),
		); r != 0 {
			h.DiskTotalGB = float64(total) / (1 << 30)
			h.DiskFreeGB = float64(free) / (1 << 30)
		}
	}
	return h
}
