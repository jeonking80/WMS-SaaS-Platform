import { describe, expect, it, vi } from 'vitest';
import { runAssistantLoop } from '../../src/server/v2/assistant';
import { assistantTools, runAssistantTool, type AssistantData } from '../../src/server/v2/assistant/tools';
import { summarize } from '../../src/app/dashboard/v2/control-ui';
import { emptyState } from '../../src/server/v2/workflow/types';

const now = '2026-10-21T03:00:00.000Z';
function data(): AssistantData & { warehouseName: string } {
  const state = { ...emptyState(), stock: [{ item_id: 'tape', location_id: 'sto', S: 30, R: 5, P: 0, Q: 0, B: 2, A: 25, H: 32 }],
    orders: [{ id: 'o1', external_id: 'SO-1', version: 1, lines: [{ id: 'l1', item_id: 'tape', quantity: 10, received: 0, cancelled: 0, shipped: 0 }], reservations: [], picks: [], delivery: {}, due_at: '2026-10-21T05:00:00.000Z', created_at: now }] };
  return { state, now, warehouseName: '부산 1센터', items: [{ id: 'tape', code: 'TP-48', name: '포장 테이프 48mm' }], locations: [{ id: 'sto', code: 'A-01', name: '보관', kind: 'STORAGE' }],
    insights: async () => ({ generated_at: now, window_days: 28, daily_outbound: [{ item_id: 'tape', day: '2026-10-21', quantity: 70 }], hourly: [{ hour: 9, flow: 'ship', quantity: 12 }], actors: [{ actor_id: 'u1', actor_name: '김작업', actions: 3, quantity: 12 }] }) };
}

describe('assistant read-only tools', () => {
  it('declares strict schemas without free-form properties', () => {
    for (const tool of assistantTools) expect(tool).toMatchObject({ strict: true, input_schema: { type: 'object', additionalProperties: false } });
  });

  it('resolves names instead of ids and keeps quantities per stock bucket', async () => {
    const result = await runAssistantTool('find_item_stock', { query: '테이프' }, data()) as { items: { item: string; total_available_ea: number; locations: { location: string; S: number; B: number }[] }[] };
    expect(result.items).toEqual([expect.objectContaining({ item: 'TP-48 · 포장 테이프 48mm', total_available_ea: 25, locations: [expect.objectContaining({ location: 'A-01 · 보관', S: 30, B: 2 })] })]);
    const risk = await runAssistantTool('list_orders_at_risk', { hours: 24 }, data()) as { orders: { order: string; remaining_ea: number; next_step: string }[] };
    expect(risk.orders).toEqual([expect.objectContaining({ order: 'SO-1', remaining_ea: 10, next_step: '예약할 수량 10 EA' })]);
  });

  it('turns direct results into Korean lines for the no-key fallback', async () => {
    const forecast = await runAssistantTool('forecast_stockouts', { limit: 5 }, data()) as Record<string, unknown>;
    expect(summarize('forecast_stockouts', forecast)).toContain('TP-48 · 포장 테이프 48mm: 가용 25 EA');
    expect(summarize('list_pending_approvals', { approvals: [] })).toBe('승인 대기 건이 없습니다.');
  });
});

describe('assistant loop', () => {
  it('runs requested tools, returns every result in one user turn, and answers from the final text', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'list_orders_at_risk', input: { hours: 24 } }, { type: 'tool_use', id: 't2', name: 'find_item_stock', input: { query: 'TP-48' } }] })
      .mockResolvedValueOnce({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'SO-1 주문이 2시간 뒤 납기입니다.' }] });
    const answer = await runAssistantLoop('데모 회사', data(), '오늘 위험한 주문?', [{ role: 'user', content: '안녕' }, { role: 'assistant', content: '안녕하세요' }], { beta: { messages: { create } } } as never);
    expect(answer).toEqual({ answer: 'SO-1 주문이 2시간 뒤 납기입니다.', tools_used: ['list_orders_at_risk', 'find_item_stock'], model: 'claude-opus-5-5' });
    const first = create.mock.calls[0][0], second = create.mock.calls[1][0];
    expect(first).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'], output_config: { effort: 'low' } });
    expect(first.messages[0].content).toContain('이전 대화:\n운영자: 안녕\n도우미: 안녕하세요');
    expect(first.system).toContain('부산 1센터');
    const results = second.messages.at(-1);
    expect(results.role).toBe('user');
    expect(results.content.map((block: { tool_use_id: string }) => block.tool_use_id)).toEqual(['t1', 't2']);
    expect(JSON.parse(results.content[0].content).orders[0].order).toBe('SO-1');
  });

  it('answers a refusal without reading content and stops after the round limit', async () => {
    const refuse = vi.fn().mockResolvedValue({ model: 'claude-opus-5-5', stop_reason: 'refusal', content: [] });
    expect((await runAssistantLoop('c', data(), 'q', [], { beta: { messages: { create: refuse } } } as never)).answer).toContain('답할 수 없습니다');
    const loop = vi.fn().mockResolvedValue({ model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'list_pending_approvals', input: {} }] });
    const answer = await runAssistantLoop('c', data(), 'q', [], { beta: { messages: { create: loop } } } as never);
    expect(loop).toHaveBeenCalledTimes(6);
    expect(answer.answer).toContain('마무리하지 못했습니다');
  });
});
