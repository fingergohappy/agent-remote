# systemd user 服务

```bash
mkdir -p ~/.config/systemd/user
cp systemd/agent-remote.service ~/.config/systemd/user/
# 改掉里面的 WorkingDirectory / ExecStart 路径
systemctl --user daemon-reload
systemctl --user enable --now agent-remote
```

日志：

```bash
journalctl --user -u agent-remote -f
```

用 `dist/` 跑（先 `npm run build`）：把 `ExecStart` 换成

```
ExecStart=/usr/bin/env node %h/code/mycode/agent-remote/dist/main.js
```

**注意 tmux socket**：服务要能操作你日常那个 tmux server。用户级 unit 默认就在你的用户会话里，
一般没问题；如果登录方式特殊导致 `tmux list-panes` 在服务里为空，
给 unit 加 `Environment=TMUX_TMPDIR=/run/user/1000` 之类，对齐你 tmux 实际用的 socket 目录。

想让服务跟着登录会话起停，可加 `systemctl --user enable --now`（已在上面）；
要在没登录时也跑，需要 `loginctl enable-linger $USER`。
