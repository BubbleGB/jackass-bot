export interface KnowledgeEntry {
  id: string; title: string; body: string; enabled: boolean; revision: number;
  bodyCharacters: number; createdAt: string; updatedAt: string;
}
export type KnowledgeSummary = Omit<KnowledgeEntry,'body'>;
export interface KnowledgePassage { entryId: string; revision: number; chunkIndex: number; title: string; text: string }
export interface KnowledgeSource {
  retrieve(guildId: string,query: string,signal: AbortSignal): Promise<KnowledgePassage[]>;
  current(guildId: string,passages: readonly KnowledgePassage[],signal: AbortSignal): Promise<boolean>;
}
