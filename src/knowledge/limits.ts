/** Owner limits use Unicode code points, not UTF-16 units or byte estimates. */
export const knowledgeLimits = {
  titleCharacters: 120,bodyCharacters: 100000,entries: 50,totalBodyCharacters: 1000000,
  defaultTokens: 2000,maxTokens: 8000,httpBodyBytes: 2*1024*1024,
  chunkCharacters: 1000,minChunkCharacters: 500,retrievedChunks: 8,
  queryCharacters: 2048,queryTerms: 32,termCharacters: 64,recentHumans: 5,
  queryTimeoutMs: 2000,
} as const;
