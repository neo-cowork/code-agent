/**
 * 聊天上传临时目录 —— 单一真源。
 *
 * web/Tauri 模式下附件经 /api/upload/temp 落盘到 `os.tmpdir()/code-agent-uploads/<uuid>/`
 * （src/web/helpers/upload.ts），且 webServer 启动/关停时整体清空。读侧
 * （Read 工具的 ENOENT 提示）按同一目录名判定「这是聊天上传的临时副本」，
 * 两侧都必须从这里取值，不许各写字面量。
 */
export const CHAT_UPLOAD_DIR_NAME = 'code-agent-uploads';

/** Per-folder request budget: half of the shared 20/min /api/upload/temp bucket, so single-file attachments right after a folder keep headroom. */
export const MAX_FOLDER_PATH_UPLOADS = 10;

/** Includes multipart overhead; bounds memory/disk consumed by one folder batch. */
export const MAX_FOLDER_BATCH_BODY_SIZE = 200 * 1024 * 1024;
/** Separate folder bucket preserves the existing single-file attachment headroom. */
export const FOLDER_BATCH_RATE_LIMIT = { max: 6, windowMs: 60_000 } as const;
