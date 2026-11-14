import { describe,it,expect } from 'vitest';
import { rebase } from '../../web/src/drafts.js';
import { settings } from '../helpers/conversation.js';
describe('dashboard conflict recovery',() => {
  it('keeps a removed provider conflict explicit instead of silently dropping its pending edits',() => {
    expect(() => rebase({ ...settings,providers: [] },{ providers: [{ provider: 'openai',effort: 'high' }] })).toThrow('provider_removed');
  });
});
