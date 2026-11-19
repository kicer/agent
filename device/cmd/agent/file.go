package main

// 文件通道：core 通过同一条 WS 拉取 / 推送文件。
//
// 协议（与 core 的 devices.js 一一对应）：
//
//	core → 节点  {t:"file", id, op:"read", path}
//	节点 → core  {t:"file.chunk", id, data:<base64>} ×N → {t:"file.done", id, size, sha256}
//
//	core → 节点  {t:"file", id, op:"write", path, size, sha256}
//	core → 节点  {t:"file.chunk", id, data} ×N → {t:"file.done", id}
//	节点 → core  {t:"file.done", id, size} 或 {t:"file.done", id, err}
//
// 写盘一律先落 <path>.part，校验通过再 rename——半截文件不能留在原地。

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"agent-device/pkg/wsnode"
	"agent-device/pkg/proto"
)

const (
	fileChunkSize = 256 << 10 // 每块 256 KiB（base64 后约 341 KiB）
	maxFileBytes  = 50 << 20  // 单文件上限 50 MiB
)

type fileWriter struct {
	path string
	tmp  *os.File
	tmpPath string
	hash hash.Hash
	got  int64
	// 期望值（core 下发时给的，用于对账）
	size int64
	sha  string
}

type fileMgr struct {
	mu      sync.Mutex
	writers map[string]*fileWriter
}

func newFileMgr() *fileMgr {
	return &fileMgr{writers: map[string]*fileWriter{}}
}

// safePath 把设备侧路径限制在 root 之内（与 exec 的 cwd 校验同一套语义）。
func (r *runner) safePath(raw string) (string, error) {
	if raw == "" {
		return "", errors.New("path 不能为空")
	}
	p := raw
	if !filepath.IsAbs(p) {
		p = filepath.Join(r.root, p)
	}
	p = filepath.Clean(p)
	rel, err := filepath.Rel(r.root, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("path 超出工作根：" + raw)
	}
	return p, nil
}

func (r *runner) fileStart(c *wsnode.Conn, m proto.Msg) {
	switch m.Op {
	case "read":
		go r.fileRead(c, m)
	case "write":
		r.fileBegin(c, m)
	default:
		r.fileFail(c, m.ID, "未知的 file.op："+m.Op)
	}
}

func (r *runner) fileFail(c *wsnode.Conn, id, msg string) {
	_ = c.Send(proto.Msg{T: proto.TKindFileDone, ID: id, Err: msg})
}

// fileRead 把设备上的文件分块推回 core。
func (r *runner) fileRead(c *wsnode.Conn, m proto.Msg) {
	p, err := r.safePath(m.Path)
	if err != nil {
		r.fileFail(c, m.ID, err.Error())
		return
	}
	f, err := os.Open(p)
	if err != nil {
		r.fileFail(c, m.ID, err.Error())
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		r.fileFail(c, m.ID, err.Error())
		return
	}
	if st.IsDir() {
		r.fileFail(c, m.ID, "是目录，不是文件："+p)
		return
	}
	if st.Size() > maxFileBytes {
		r.fileFail(c, m.ID, "文件超过 50MiB 上限")
		return
	}

	h := sha256.New()
	buf := make([]byte, fileChunkSize)
	var sent int64
	for {
		n, rerr := f.Read(buf)
		if n > 0 {
			h.Write(buf[:n])
			sent += int64(n)
			if err := c.Send(proto.Msg{
				T: proto.TKindFileChunk, ID: m.ID,
				Data: append([]byte(nil), buf[:n]...),
			}); err != nil {
				return
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			r.fileFail(c, m.ID, rerr.Error())
			return
		}
	}
	_ = c.Send(proto.Msg{
		T: proto.TKindFileDone, ID: m.ID,
		Size: sent, SHA: hex.EncodeToString(h.Sum(nil)),
	})
}

// fileBegin 为一次 write 建立临时文件。
func (r *runner) fileBegin(c *wsnode.Conn, m proto.Msg) {
	p, err := r.safePath(m.Path)
	if err != nil {
		r.fileFail(c, m.ID, err.Error())
		return
	}
	if m.Size > maxFileBytes {
		r.fileFail(c, m.ID, "文件超过 50MiB 上限")
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		r.fileFail(c, m.ID, err.Error())
		return
	}
	tmpPath := p + ".part"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		r.fileFail(c, m.ID, err.Error())
		return
	}
	r.files.mu.Lock()
	r.files.writers[m.ID] = &fileWriter{
		path: p, tmp: f, tmpPath: tmpPath, hash: sha256.New(),
		size: m.Size, sha: m.SHA,
	}
	r.files.mu.Unlock()
}

func (r *runner) fileChunk(c *wsnode.Conn, m proto.Msg) {
	r.files.mu.Lock()
	w := r.files.writers[m.ID]
	r.files.mu.Unlock()
	if w == nil {
		return
	}
	if w.got+int64(len(m.Data)) > maxFileBytes {
		r.abortWriter(m.ID, w, "超过 50MiB 上限")
		r.fileFail(c, m.ID, "超过 50MiB 上限")
		return
	}
	if _, err := w.tmp.Write(m.Data); err != nil {
		r.abortWriter(m.ID, w, err.Error())
		r.fileFail(c, m.ID, err.Error())
		return
	}
	w.hash.Write(m.Data)
	w.got += int64(len(m.Data))
}

// fileEnd 收尾写入：校验大小与 sha256，通过才改名到正式路径。
func (r *runner) fileEnd(c *wsnode.Conn, m proto.Msg) {
	r.files.mu.Lock()
	w := r.files.writers[m.ID]
	delete(r.files.writers, m.ID)
	r.files.mu.Unlock()
	if w == nil {
		return
	}
	defer func() { _ = w.tmp.Close() }()

	sum := hex.EncodeToString(w.hash.Sum(nil))
	if w.size > 0 && w.got != w.size {
		_ = os.Remove(w.tmpPath)
		r.fileFail(c, m.ID, "大小不符：收到 "+strconv.FormatInt(w.got, 10)+"，应为 "+strconv.FormatInt(w.size, 10))
		return
	}
	if w.sha != "" && !strings.EqualFold(w.sha, sum) {
		_ = os.Remove(w.tmpPath)
		r.fileFail(c, m.ID, "sha256 不符")
		return
	}
	if err := w.tmp.Close(); err != nil {
		_ = os.Remove(w.tmpPath)
		r.fileFail(c, m.ID, err.Error())
		return
	}
	if err := os.Rename(w.tmpPath, w.path); err != nil {
		_ = os.Remove(w.tmpPath)
		r.fileFail(c, m.ID, err.Error())
		return
	}
	_ = c.Send(proto.Msg{T: proto.TKindFileDone, ID: m.ID, Size: w.got, SHA: sum})
}

func (r *runner) abortWriter(id string, w *fileWriter, why string) {
	r.files.mu.Lock()
	delete(r.files.writers, id)
	r.files.mu.Unlock()
	_ = w.tmp.Close()
	_ = os.Remove(w.tmpPath)
}
