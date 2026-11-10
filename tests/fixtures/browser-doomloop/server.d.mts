import type { Server } from 'node:http';

export function startFixture(port?: number): Promise<{
  server: Server;
  port: number;
  bootAt: number;
}>;
