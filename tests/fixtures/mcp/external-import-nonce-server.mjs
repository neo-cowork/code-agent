import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { McpServer } from '@modelcontextprotocol/server';

const nonce = randomUUID();
const server = new McpServer({ name: 'external-import-nonce-fixture', version: '1.0.0' });

server.registerTool(
  'get_random_nonce',
  { description: 'Return this offline MCP server process\'s random nonce.' },
  async () => ({
    content: [{ type: 'text', text: `EXTERNAL_MCP_NONCE=${nonce}` }],
  }),
);

await server.connect(new StdioServerTransport());
