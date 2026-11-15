import { knowledgeLimits as limits } from './limits.js';
export const characters = (s: string): number => Array.from(s).length;
const graphemes = new Intl.Segmenter(undefined,{ granularity: 'grapheme' });
export function prefix(s: string,n: number): string {
  let size = 0,result = ''; for (const { segment } of graphemes.segment(s)) { size += characters(segment); if (size > n) break; result += segment; } return result;
}
export function validText(s: unknown,max: number): s is string {
  return typeof s === 'string' && s.isWellFormed() && !s.includes('\0') && s.trim().length > 0 && characters(s) <= max;
}
export function chunks(body: string): string[] {
  const points = Array.from(graphemes.segment(body),s => s.segment),result: string[] = [];
  for (let start = 0; start < points.length;) {
    let end = start,size = 0,space = -1;
    while (end < points.length && (size+characters(points[end]!) <= limits.chunkCharacters || end === start)) {
      size += characters(points[end]!); end++; if (size >= limits.minChunkCharacters && /\s/u.test(points[end-1]!)) space = end;
    }
    if (end < points.length && space > start) end = space;
    const text = points.slice(start,end).join(''); if (text.trim()) result.push(text); start = end;
  }
  return result;
}
const stop = new Set('a an the and or is are was were be to of in on for with this that it i we you me my our your what how where when please can could would should do does'.split(' '));
/** Only Unicode word terms enter the tsquery parameter; never user operators/syntax. */
export function searchQuery(text: string): string {
  const words = prefix(text.normalize('NFKC'),limits.queryCharacters).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [];
  return [...new Set(words.filter(w => !stop.has(w) && characters(w) <= limits.termCharacters))].slice(0,limits.queryTerms).join(' | ');
}
