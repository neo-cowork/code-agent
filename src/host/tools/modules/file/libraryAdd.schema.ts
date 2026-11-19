import type { ToolSchema } from '../../../protocol/tools';

export const libraryAddSchema: ToolSchema = {
  name: 'library_add',
  description:
    'Copy a local file into the user\'s Library. The copy shows up in the Library panel and can be pinned to later chats. '
    + 'Use this when the user asks to put a file in the Library, save it to the Library, archive it, or add it '
    + '(资料库 / 放进资料库 / 入库 / 归档 / library / add to library). '
    + 'Pass the file you just wrote. Do not search the app data folder for a library location. '
    + 'This writes a copy and needs approval. If it fails, tell the user to open the Library panel and upload the file.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Local file to copy into the Library. ~ is expanded. A file inside the app data folder is rejected.',
      },
      title: {
        type: 'string',
        description: 'Optional name shown for this item in the Library panel. Defaults to the file name.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional labels stored with the Library item.',
      },
    },
    required: ['file_path'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInTextForeground: true,
  allowInPlanMode: false,
  pathAuthority: [{ kind: 'path', pathParameter: 'file_path' }],
  accesses: [
    { kind: 'read', argumentNames: ['file_path'] },
  ],
};
