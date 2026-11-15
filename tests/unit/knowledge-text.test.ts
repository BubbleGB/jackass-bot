import { describe,it,expect } from 'vitest';
import { characters,prefix,chunks,searchQuery,validText } from '../../src/knowledge/text.js';
import { knowledgeLimits as limits } from '../../src/knowledge/limits.js';
describe('central knowledge text limits and Unicode-safe local retrieval',() => {
  it('counts astral code points and rejects invalid text without truncation',() => {
    expect(characters('A🌌é')).toBe(3); expect(validText('🌌'.repeat(100000),limits.bodyCharacters)).toBe(true);
    for (const text of ['', '   ','\0','\ud800','\udc00','x'.repeat(121)]) expect(validText(text,limits.titleCharacters)).toBe(false);
  });
  it('never cuts surrogate pairs or grapheme sequences when trimming',() => {
    expect(prefix('A🌌B',2)).toBe('A🌌'); expect(prefix('A👨‍👩‍👧‍👦B',3)).toBe('A'); expect(prefix('e\u0301B',1)).toBe('');
  });
  it('splits searchable passages deterministically and rejoins exactly with graphemes intact',() => {
    const text = ('Orbit café 👨‍👩‍👧‍👦!\n').repeat(200),parts = chunks(text);
    expect(parts.join('')).toBe(text); expect(chunks(text)).toEqual(parts); expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(p => p.isWellFormed() && !p.endsWith('\u200d') && !p.startsWith('\u200d'))).toBe(true);
  });
  it('normalises punctuation/Unicode, omits empty queries and bounds word terms without query operators',() => {
    expect(searchQuery('🌌 -- () & | !')).toBe(''); expect(searchQuery('Hi!')).toBe('hi');
    expect(searchQuery('CAFÉ cafe\u0301 月亮')).toBe('café | 月亮');
    expect(searchQuery('x\'); DROP TABLE knowledge_entries; --')).not.toMatch(/[';()&!:]/);
    expect(searchQuery(Array.from({ length: 100 },(_,i) => 'orbit'+i).join(' ')).split(' | ')).toHaveLength(limits.queryTerms);
  });
  it('omits whitespace-only search chunks at exact boundaries without changing meaningful passages',() => {
    const body = 'fact '.repeat(200)+'\n';
    expect(validText(body,limits.bodyCharacters)).toBe(true);
    expect(chunks(body)).toEqual(['fact '.repeat(200)]);
  });
});
