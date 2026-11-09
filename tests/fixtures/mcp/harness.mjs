// MCP 测试用稳定 harness（不依赖 .refs/SDK；两次输出逐字节一致）
const rows = [{ scenario: 'mcp-fixture', pages: [{ pageIndex: 0, text: 'stable' }] }];
process.stdout.write(JSON.stringify(rows) + '\n');
