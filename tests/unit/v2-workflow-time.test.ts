import { describe, expect, it } from 'vitest';
import { businessDayAt, businessInputTime, businessInputTimestamp } from '../../src/app/dashboard/v2/workflow-time';

describe('Korea business datetime entry', () => {
  it('shows and submits Korea time even in a UTC browser equivalent', () => {
    // Explicit UTC instants have the same meaning in every host/browser timezone.
    expect(businessInputTime('2026-10-21T00:30:00Z')).toBe('2026-10-21T09:30');
    expect(businessInputTimestamp('2026-10-21T09:30')).toBe('2026-10-21T00:30:00.000Z');
    expect(businessInputTime('2026-10-21T23:30:00Z')).toBe('2026-10-22T08:30');
    expect(businessInputTimestamp('2026-10-22T00:00')).toBe('2026-10-21T15:00:00.000Z');
  });

  it('round trips valid leap days and equivalent timestamp offsets', () => {
    expect(businessInputTimestamp('2028-02-29T09:00')).toBe('2028-02-29T00:00:00.000Z');
    expect(businessInputTime('2028-02-29T09:00:00+09:00')).toBe('2028-02-29T09:00');
  });

  it.each(['', 'invalid', '2026-02-29T09:00', '2026-04-31T09:00', '2026-13-01T09:00', '2026-10-21T24:00', '2026-10-21T09:60', '2026-10-21T09:30Z', '0000-01-01T00:00'])('rejects invalid local datetime %s', value => {
    expect(businessInputTimestamp(value)).toBeUndefined();
  });

  it('leaves absent and invalid saved timestamps empty', () => {
    expect(businessInputTime()).toBe('');
    expect(businessInputTime('invalid')).toBe('');
  });
});

describe('Korea business day quick fill', () => {
  it('uses the Korea calendar day even when UTC is still the previous day', () => {
    expect(businessDayAt(0, 18, new Date('2026-10-20T16:30:00Z'))).toBe('2026-10-21T18:00');
    expect(businessDayAt(1, 9, new Date('2026-10-20T16:30:00Z'))).toBe('2026-10-22T09:00');
    expect(businessDayAt(1, 9, new Date('2026-12-31T05:00:00Z'))).toBe('2027-01-01T09:00');
    expect(businessInputTimestamp(businessDayAt(0, 18, new Date('2026-10-21T00:00:00Z')))).toBe('2026-10-21T09:00:00.000Z');
  });
});
