//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// setupProc 让命令自成一个进程组，后面才能整组杀（sh 拉起的子进程一起收）。
func setupProc(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProc 负号 = 整个进程组。忽略错误：进程可能已自行退出。
func killProc(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
