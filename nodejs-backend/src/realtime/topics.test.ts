import {
  dealTopic,
  dealsTopic,
  entityTopic,
  isRealtimeTopic,
  orderTopic,
  ordersTopic,
  parseRealtimeTopic,
  topicPermissionRequirement,
} from './topics.js';

describe('realtime topics', () => {
  it('builds collection topics', () => {
    expect(dealsTopic()).toBe('deals');
    expect(ordersTopic()).toBe('orders');
  });

  it('builds entity topics', () => {
    expect(entityTopic('deal', 'abc-123')).toBe('entity:deal:abc-123');
    expect(dealTopic('d1')).toBe('entity:deal:d1');
    expect(orderTopic('o1')).toBe('entity:order:o1');
  });

  it('parses collection topics', () => {
    expect(parseRealtimeTopic('deals')).toEqual({ kind: 'collection', topic: 'deals' });
  });

  it('parses entity topics', () => {
    expect(parseRealtimeTopic('entity:order:o_1')).toEqual({
      kind: 'entity',
      topic: 'entity:order:o_1',
      entityType: 'order',
      entityId: 'o_1',
    });
  });

  it.each([
    '',
    'unknown',
    'entity:deal',
    'entity:deal:',
    'entity:deal:a:b',
    'entity:unknown:1',
    'entity:deal:bad id',
    `entity:deal:${'x'.repeat(65)}`,
    `${'x'.repeat(200)}`,
  ])('rejects malformed topic %p', (value) => {
    expect(parseRealtimeTopic(value)).toBeNull();
    expect(isRealtimeTopic(value)).toBe(false);
  });

  it('maps topics onto permission requirements', () => {
    expect(topicPermissionRequirement('deals')).toEqual({ resource: 'deals', action: 'read' });
    expect(topicPermissionRequirement('entity:contact:c1')).toEqual({
      resource: 'contacts',
      action: 'read',
    });
    expect(topicPermissionRequirement('nope')).toBeNull();
  });
});
