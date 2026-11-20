//go:build windows

package main

import (
	"context"
	"os/exec"
	"strconv"
	"syscall"
)

const createNewProcessGroup = 0x00000200

// setupProc 让命令自成一组，taskkill /T 才能连子进程一起收。
func setupProc(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
}

func killProc(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = newCmd(context.Background(), "taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	_ = cmd.Process.Kill()
}
