/**
 * 聊天上传目录与保留期 —— 单一真源。
 *
 * web/Tauri 模式下附件经 /api/upload/temp（及 /batch）落盘到 `<userData>/uploads/<uuid>/`
 * （src/web/helpers/upload.ts），不在关停时清空，仅在启动时按保留期回收超龄子目录，
 * 从而跨重启与多实例存活。历史会话的旧路径在 `os.tmpdir()/code-agent-uploads/<uuid>/`；
 * 读侧（ENOENT 提示）同时识别新旧两个根，统一给出「上传已过期，请重新上传」。
 */
export const CHAT_UPLOAD_DIR_NAME = 'code-agent-uploads';
export const CHAT_UPLOAD_SUBDIR_NAME = 'uploads';
export const CHAT_UPLOAD_RETENTION_DAYS = 30;

/** Per-folder request budget: half of the shared 20/min /api/upload/temp bucket, so single-file attachments right after a folder keep headroom. */
export const MAX_FOLDER_PATH_UPLOADS = 10;

/** Includes multipart overhead; bounds memory/disk consumed by one folder batch. */
export const MAX_FOLDER_BATCH_BODY_SIZE = 200 * 1024 * 1024;
/** Separate folder bucket preserves the existing single-file attachment headroom. */
export const FOLDER_BATCH_RATE_LIMIT = { max: 6, windowMs: 60_000 } as const;
