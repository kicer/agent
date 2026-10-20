// SQLite 数据层：建表与常用查询。
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { dayString } = require('./time');

function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT '',
      status TEXT NOT NULL,
      model_id TEXT,
      last_model_id TEXT,
      assistant_type TEXT DEFAULT 'secretary',
      user TEXT DEFAULT '',
      profile TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      cancelled_at INTEGER,
      held_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      reasoning TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      name TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
  `);
  // 升级老库：早期表不带 reasoning 列，补上（重入安全；不在上面 db.exec 模板串里，免得被当作 SQL 解析）
  try { db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT'); } catch (_) { /* 已存在 */ }
  // 升级老库：type 标记特殊消息行。目前唯一取值 'errAck'——AI 的 tool call 参数错误
  // （JSON 非法/缺必填）整条标记；仍入库供 UI 展示，但 buildMessages 发请求时跳过（见 llm.js）
  try { db.exec('ALTER TABLE messages ADD COLUMN type TEXT'); } catch (_) { /* 已存在 */ }
  // 升级老库：tool 回执执行失败标记。此前只走 SSE 不落库，重进会话后 UI 丢失红色错误样式
  try { db.exec('ALTER TABLE messages ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0'); } catch (_) { /* 已存在 */ }
  // 升级老库：assistant 消息的 token 用量 {pt,ct,cached} JSON（msg-actions 展示 In/Out/缓存命中率）
  try { db.exec('ALTER TABLE messages ADD COLUMN usage TEXT'); } catch (_) { /* 已存在 */ }
  db.exec(`

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- 模型池：一行一个物理 key 槽位（id=「平台#下标」），由配置重建（见 engine.syncModelPool）。
    -- key 不再独占（多会话可共享同一 key 并发 looping），调度只是按「最不 active」优顺序选（见 engine.chooseKey）。
    -- is_busy / current_session_id 是旧版独占时代的残留列：保留不读写，只存 last_used_at（轮转依据）。
    CREATE TABLE IF NOT EXISTS model_pool (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      is_busy INTEGER DEFAULT 0,
      current_session_id TEXT,
      last_used_at INTEGER
    );

    -- 旧版 FIFO 等待队列表：已废弃（排队语义整体移除，会话绑不到模型不再挂队等而是直接报错），
    -- 表与列保留（SQLite 删表不值得），代码不再读写。
    CREATE TABLE IF NOT EXISTS wait_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- 杂项持久计数/标记（如每日任务序号 task_seq:YYYYMMDD，删除会话后不回退复用）
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- 定时任务：AI 通过 schedule 工具为会话创建周期任务（每会话至多一个），
    -- 由 scheduler.js 轮询投递。session_id 作主键：一行代码同时实现「1 会话 1 任务」
    -- 与「防重复插入」（重复 INSERT 直接撞主键）；REFERENCES ... ON DELETE CASCADE
    -- 让删会话时任务自动消失（db 已开 foreign_keys）。next_run_at 创建时即算好，
    -- 调度器只做 <= now 比较；last_note 存给人看的中文说明，UI 原样展示。
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      cron_expr   TEXT    NOT NULL,
      prompt      TEXT    NOT NULL,
      next_run_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_status TEXT,             -- ok | error | skipped | running
      last_note   TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sched_next ON scheduled_tasks(next_run_at);

    -- 文本命令接入端（channel）的「当前会话」绑定（routes/channel.js）：接入端没有会话列表 UI，
    -- 每个 (user, channel) 记一个当前会话，普通消息与 /new 等命令都作用于它。
    -- 故意不建外键：删会话后绑定行由 channel 层懒解析自愈（查不到会话即清行按未绑定处理）。
    CREATE TABLE IF NOT EXISTS channel_sessions (
      user TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user, channel)
    );

    -- 长期记忆（日记，memory.js）：一片碎片一行——会话收口（下班）时落库，(user, session_id) 主键即去重。
    -- day = 事件日（上海时区，time.js 固定，与 cron 同源）：由 last_active_at 派生；人回忆问「哪天干的活」，不是「哪天补记的」。
    -- text = 纯日记正文（- 行列表）；来源会话 id 存在 session_id 列，【id】展示样式只在渲染层拼，存储零冗余。
    -- 故意不建外键：主键是 (user, session_id)，SQLite 要求引用列命中唯一约束，单列 session_id
    -- 建不了 FK；且删会话的连带清理由 engine.deleteSession 显式 memory.dropFragment 承担
    --（与 scheduled_tasks 的 ON DELETE CASCADE 同效果，语义归代码层说清）。
    -- 旧版曾定调「删会话不能抹掉已记入的日记」，已推翻：会话正文与成果文件都没了，碎片再无出处。
    CREATE TABLE IF NOT EXISTS memory_fragments (
      user TEXT NOT NULL,
      session_id TEXT NOT NULL,
      day TEXT NOT NULL,             -- 'YYYY-MM-DD'（事件日）
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,   -- 收口时刻（写入/迁移时间，不当作事件时刻）
      last_active_at INTEGER,        -- 最后一条真实 user/assistant 消息的时刻（收口时快照；存量回填可为 NULL）
      PRIMARY KEY (user, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_memfrag_day ON memory_fragments(user, day);

    -- 微信绑定（wechat.js）：一条 core 用户 ↔ 一个 wxbot iLink bot 实例（扫码登录后仅本人可与 bot 单线对话，
    -- 协议保证无陌生人入口）。binding id 同时用作 channel 键（'wx:'+id，走 routes/channel.js 同一套命令层）
    -- 和 wxbot 凭证目录名，权威在本表；投递游标 last_msg_id 落库，重启不重发旧回复。
    CREATE TABLE IF NOT EXISTS wechat_bindings (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending 等扫码 | online | expired | error
      note TEXT,                                -- 错误/状态说明，面板原样展示
      bot_account_id TEXT,                      -- bot 上线后的微信账号标识（登录回调带回，展示用）
      wx_to_user TEXT,                          -- 最近来话人 userId（deliver 回发对象；实际上只会是主人自己）
      last_msg_id INTEGER NOT NULL DEFAULT 0,   -- 投递游标：id ≤ 此值的 assistant 消息已送过微信
      deep_think INTEGER NOT NULL DEFAULT 0,    -- 微信端全局深度思考开关（/think；= H5 按钮的微信形态，
                                                -- 随绑定不随会话；投递时替进消息 API 的 deepThink 字段；默认关）
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 模型 token 用量流水（每次模型回合一条）。故意不建会话外键：
    -- 删会话后累计统计仍需保留
    CREATE TABLE IF NOT EXISTS model_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- 用户画像（user-profile.js）：一行一个登录用户，跨会话共享；未启用认证时为空串键的隐式单用户。
    -- data = {honorific,industry,preference} JSON（只记「不知道就会做错」的信息，封闭 schema）；
    -- enabled 用户级开关：关 = 新会话不冻结注入快照、也不再提取更新。
    CREATE TABLE IF NOT EXISTS user_profiles (
      user TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
    CREATE INDEX IF NOT EXISTS idx_model_usage_model_time ON model_usage(model_id, created_at);
  `);
  // 升级老库：model_usage 补 cached_tokens 列（输入 token 缓存命中量累计，算历史命中率）
  try { db.exec('ALTER TABLE model_usage ADD COLUMN cached_tokens INTEGER DEFAULT 0'); } catch (_) { /* 已存在 */ }
  // 升级老库：旧库补 held_at 列（进入 held 的时刻；现仅展示/自动压缩校验用，租约到期逻辑已随「key 不独占」一并移除）
  const cols = db.prepare('PRAGMA table_info(sessions)').all();
  if (!cols.some(c => c.name === 'held_at')) db.exec('ALTER TABLE sessions ADD COLUMN held_at INTEGER');
  // 迁移：长期记忆收口时刻（memory/engine）：每会话唯一碎片的物理标记，兼做 4h 空闲扫描的预排除
  //（updated_at 门槛一旦越过就永远成立，没有这个标记陈年会话会被每轮扫描重复摘要）。
  if (!cols.some(c => c.name === 'journaled_at')) db.exec('ALTER TABLE sessions ADD COLUMN journaled_at INTEGER');
  // 升级老库：scheduled_tasks 补 brief 列（人话描述「这个任务干什么」，AI 创建时必填；设定任务即下班，
  // brief 直接充当会话的日记碎片底子，零 LLM 成本）。默认空串：存量任务无 brief，其下班碎片降级用 prompt 首行。
  const schedCols = db.prepare('PRAGMA table_info(scheduled_tasks)').all();
  if (!schedCols.some(c => c.name === 'brief')) db.exec("ALTER TABLE scheduled_tasks ADD COLUMN brief TEXT NOT NULL DEFAULT ''");
  // 升级老库：scheduled_tasks 补 script 列（可选标记：任务脚本的文件名）。纯标记——创建不验存在、
  // 触发不验存在（参数存在本身就是对 AI 的脚本化暗示，怎么写进 prompt、用 bash 还是 python 由它自定）；
  // get 详情里展示这个「肌肉记忆长在哪」。与 brief 同构，新库建表后也靠本迁移补列。
  if (!schedCols.some(c => c.name === 'script')) db.exec("ALTER TABLE scheduled_tasks ADD COLUMN script TEXT NOT NULL DEFAULT ''");
  // 升级老库：scheduled_tasks 补 notify_channel 列——schedule op=create 时记下的微信通道（'wx:'+bid）：
  // 谁设的闹钟通知谁，专柜退位后仍能找得到人。空串 = 存量任务/网页端建的任务，完成通知退回该用户全部在线绑定。
  if (!schedCols.some(c => c.name === 'notify_channel')) db.exec("ALTER TABLE scheduled_tasks ADD COLUMN notify_channel TEXT NOT NULL DEFAULT ''");
  // 迁移：model_slot 记会话粘住的具体池 key 槽位（「平台#key下标」，key 为共享资源不再独占），
  // 跨结版/重启保持（只有手动换绑或模型失效改选会动），model_id 存模型 id 供展示/统计（见 engine.applyBinding）。
  if (!cols.some(c => c.name === 'model_slot')) db.exec('ALTER TABLE sessions ADD COLUMN model_slot TEXT');
  // 迁移：model_pool 一行一个物理 key 槽位（id=「平台#下标」），last_used_at 支撑「最久未用先上」轮转（见 engine.chooseKey）
  const poolCols = db.prepare('PRAGMA table_info(model_pool)').all();
  if (!poolCols.some(c => c.name === 'last_used_at')) db.exec('ALTER TABLE model_pool ADD COLUMN last_used_at INTEGER');
  // 迁移：last_model_id 记住会话最近用过的模型（换绑时一并刷新），绑定失效时供 ensureBinding 优先回原平台/原模型
  if (!cols.some(c => c.name === 'last_model_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN last_model_id TEXT');
    db.exec('UPDATE sessions SET last_model_id = model_id WHERE last_model_id IS NULL AND model_id IS NOT NULL');
  }
  // 迁移：assistant_type 标记会话的 AI 助手类型（secretary=文秘助理 / vision=识图专家），
  // 建档时选定，后续不可变更；存量老会话按默认文秘助理回填
  if (!cols.some(c => c.name === 'assistant_type')) {
    db.exec("ALTER TABLE sessions ADD COLUMN assistant_type TEXT DEFAULT 'secretary'");
  }
  // 迁移：user 记录建档时的登录用户，列表接口据此按用户隔离；
  // 存量老会话与未启用认证时建的会话为空串（见 routes/sessions.js 列表过滤）
  if (!cols.some(c => c.name === 'user')) {
    db.exec("ALTER TABLE sessions ADD COLUMN user TEXT DEFAULT ''");
  }
  // 升级老库：profile 曾记会话绑定的 prompt+tools 组合名（bind 弹窗「模式」区）。已废弃：
  // 前端手动切换模式全部移除，profile 选取只剩模型配置默认一档（见 engine.resolveProfileName）；
  // 列保留（SQLite 删列不值得），代码不再读写。
  if (!cols.some(c => c.name === 'profile')) {
    db.exec("ALTER TABLE sessions ADD COLUMN profile TEXT DEFAULT ''");
  }
  // 迁移：profile_snapshot 存会话创建/清空时冻结的用户画像注入文本（buildMessages 每轮首条 user 注入，
  // 字节恒定不破坏前缀缓存；不入 messages 表，压缩动不到它，见 user-profile.js）。
  if (!cols.some(c => c.name === 'profile_snapshot')) db.exec("ALTER TABLE sessions ADD COLUMN profile_snapshot TEXT DEFAULT ''");
  // 迁移：title_locked 用户手动重命名过标题（renameSession 置 1）：显式留痕「名字是用户起的」，
  // 不得静默冲掉；清空会话时随标题一并复位（旧名字已文不对题）。
  if (!cols.some(c => c.name === 'title_locked')) db.exec("ALTER TABLE sessions ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0");
  // 迁移：wechat_bindings 补 deep_think 列——微信端全局深度思考开关（routes/channel.js /think 读写，
  // 投递时作为既有 deepThink 参数的取值来源）；默认 0=关（与 H5 按钮初始态一致，/think on 手动开）。
  // 旧库若曾按 DEFAULT 1 补过列（当时默认开，存量行都是默认值回填而非用户显式选择），
  // SQLite 改不了列默认，重建表把默认关回 0 并一键关存量；重建后 dflt_value 不再为 1，天然幂等。
  const bindCols = db.prepare('PRAGMA table_info(wechat_bindings)').all();
  if (!bindCols.some(c => c.name === 'deep_think')) {
    db.exec('ALTER TABLE wechat_bindings ADD COLUMN deep_think INTEGER NOT NULL DEFAULT 0');
  } else if (bindCols.some(c => c.name === 'deep_think' && String(c.dflt_value) === '1')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE wechat_bindings__v2 (
          id TEXT PRIMARY KEY,
          user TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          note TEXT,
          bot_account_id TEXT,
          wx_to_user TEXT,
          last_msg_id INTEGER NOT NULL DEFAULT 0,
          deep_think INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO wechat_bindings__v2 (id, user, status, note, bot_account_id, wx_to_user, last_msg_id, deep_think, created_at, updated_at)
        SELECT id, user, status, note, bot_account_id, wx_to_user, last_msg_id, 0, created_at, updated_at FROM wechat_bindings;
        DROP TABLE wechat_bindings;
        ALTER TABLE wechat_bindings__v2 RENAME TO wechat_bindings;
      `);
    })();
  }
  // 迁移：advising（顾问阶段）概念已全部移除，会话不再有 phase 语义；旧列直接删。
  // 旧 SQLite 不支持 DROP COLUMN（<3.35）时静默跳过：残留死列无妨，代码已不再读写它。
  try { db.exec('ALTER TABLE sessions DROP COLUMN phase'); } catch (_) { /* 旧版本 SQLite，保留死列 */ }
  // 迁移（C 重构）：memory_entries「一天一行拼 blob」→ memory_fragments「一片一行」。幂等：旧表存在才搬，
  // 搬完即 drop；解析不出【sid】头的块（DAY_MAX 时代削出的孤儿残句）直接丢弃；
  // 存量碎片的 day 顺手改判为来源会话最后活跃日（事件日语义修正，积压补记自然散布回真实日期）。
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_entries'").get()) {
    const mf = db.prepare('INSERT OR IGNORE INTO memory_fragments (user, session_id, day, text, created_at) VALUES (?,?,?,?,?)');
    const getUpd = db.prepare('SELECT updated_at FROM sessions WHERE id = ?');
    for (const r of db.prepare('SELECT user, day, content, updated_at FROM memory_entries').all()) {
      for (const block of String(r.content || '').split('\n\n')) {
        const m = /^【([^】]*)】\n?([\s\S]*)$/.exec(block.trim());
        if (!m || !m[2].trim()) continue;
        const sidM = /task-[0-9A-Za-z_-]+/.exec(m[1]); // 兼容三代头格式：【标题 · sid】/【sid】
        if (!sidM) continue;
        const srow = getUpd.get(sidM[0]);
        mf.run(r.user, sidM[0], srow && srow.updated_at ? dayString(srow.updated_at) : r.day, m[2].trim(), r.updated_at || Date.now());
      }
    }
    db.exec('DROP TABLE memory_entries');
  }
  // 清理（一次性、幂等）：旧版「删会话不抹日记」留下的孤儿碎片——来源会话已不在，
  // 回忆时既翻不出原文也带不出成果文件，纯幽灵记忆（还会白占 inject_max 注入额度）。
  // 现行规则：会话销毁即连带撕碎片（engine.deleteSession → memory.dropFragment），本语句只负责清掉历史脏数据。
  const orphan = db.prepare(
    'DELETE FROM memory_fragments WHERE session_id NOT IN (SELECT id FROM sessions)'
  ).run().changes || 0;
  if (orphan) console.log('[db] 清理孤儿日记碎片 ' + orphan + ' 条（来源会话已删除）');
  // 迁移：日记碎片补 last_active_at（最后真实对话时刻）。created_at 是收口/迁移时间，不能当事件时刻；
  // 存量行按「最后真实消息 → updated_at → created_at」找第一个上海日期等于 day 的候选，找不到就留 NULL
  //（渲染时只显示日期）。放在 memory_entries 迁移之后，刚搬过来的行也能一起回填。
  try { db.exec('ALTER TABLE memory_fragments ADD COLUMN last_active_at INTEGER'); } catch (_) { /* 已存在 */ }
  const needStamp = db.prepare('SELECT 1 FROM memory_fragments WHERE last_active_at IS NULL LIMIT 1').get();
  if (needStamp) {
    const lastMsg = db.prepare(
      "SELECT MAX(created_at) AS m FROM messages WHERE session_id = ? AND type IS NULL AND role IN ('user','assistant')"
    );
    const getUpdated = db.prepare('SELECT updated_at FROM sessions WHERE id = ?');
    const setStamp = db.prepare('UPDATE memory_fragments SET last_active_at = ? WHERE user = ? AND session_id = ?');
    for (const f of db.prepare('SELECT user, session_id, day, created_at FROM memory_fragments WHERE last_active_at IS NULL').all()) {
      const m = lastMsg.get(f.session_id);
      const s = getUpdated.get(f.session_id);
      const cands = [m && m.m, s && s.updated_at, f.created_at].filter(Boolean).map(Number);
      const pick = cands.find(ms => dayString(ms) === f.day);
      if (pick) setStamp.run(pick, f.user, f.session_id);
    }
  }
  return db;
}

module.exports = { initDb };
