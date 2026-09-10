import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { openJson, openText } from '../../crypto/envelope.js';
import { answerFromEvidence, parseQuery, type Evidence } from '../../gemini/ask.js';
import { embedContent } from '../../gemini/client.js';
import { binding } from '../../pipeline/process.js';
import { materializeTranscript } from '../../pipeline/source-materialize.js';
import * as db from '../../store/firestore.js';
import type { ConversationDoc, SegmentDoc, StructuredMemory } from '../../store/types.js';
import { nameKey, normalizeName, topicKey } from '../../util/ids.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RECENT_RECORDINGS = 80;
const MAX_EXCERPT = 6_000;

const askBody = z.object({
  query: z.string().min(1).max(1000),
  scope: z.object({
    from: z.string().regex(DAY_PATTERN).nullable().optional(),
    to: z.string().regex(DAY_PATTERN).nullable().optional(),
    people: z.array(z.string()).max(10).optional(),
    topics: z.array(z.string()).max(10).optional(),
  }).optional(),
  max_sources: z.number().int().min(1).max(20).optional(),
});

const STOP_WORDS = new Set([
  'the','and','for','that','this','with','what','when','where','which','who','why','how','did','does','was','were','are',
  'about','from','have','has','had','said','say','tell','me','my','our','your','his','her','their','they','them','you','can',
  'could','would','kya','hai','tha','thi','mein','main','ka','ki','ke','ko','se','aur','par','ne',
]);

function terms(value: string): string[] {
  return [...new Set(String(value || '').normalize('NFKC').toLocaleLowerCase('und')
    .split(/[^\p{L}\p{N}_-]+/u).map((part) => part.trim())
    .filter((part) => part.length >= 2 && !STOP_WORDS.has(part)))].slice(0, 24);
}

function score(text: string, queryTerms: string[]): number {
  const haystack = String(text || '').normalize('NFKC').toLocaleLowerCase('und');
  let total = 0;
  for (const term of queryTerms) {
    let at = haystack.indexOf(term);
    let count = 0;
    while (at >= 0 && count < 10) {
      total += count === 0 ? 4 : 1;
      count += 1;
      at = haystack.indexOf(term, at + term.length);
    }
  }
  return total;
}

function excerpt(text: string, queryTerms: string[], max = MAX_EXCERPT): string {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  const lower = value.normalize('NFKC').toLocaleLowerCase('und');
  const positions = queryTerms.map((term) => lower.indexOf(term)).filter((at) => at >= 0).sort((a, b) => a - b);
  const focus = positions[0] ?? 0;
  const start = Math.max(0, Math.min(value.length - max, focus - Math.floor(max * 0.3)));
  const end = Math.min(value.length, start + max);
  return `${start ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`;
}

function inDayScope(day: string, from?: string | null, to?: string | null): boolean {
  return !(from && day < from) && !(to && day > to);
}

function memoryScopeMatches(memory: StructuredMemory | null, people: string[], topics: string[], transcript: string): boolean {
  if (people.length) {
    const present = new Set((memory?.people || []).map((person) => normalizeName(person.name)));
    const transcriptNames = transcript.normalize('NFKC').toLocaleLowerCase('und');
    if (!people.some((name) => present.has(normalizeName(name)) || transcriptNames.includes(normalizeName(name)))) return false;
  }
  if (topics.length) {
    const present = new Set((memory?.topics || []).map(topicKey).filter(Boolean));
    const transcriptTopics = transcript.normalize('NFKC').toLocaleLowerCase('und');
    if (!topics.some((topic) => present.has(topicKey(topic)) || transcriptTopics.includes(String(topic).toLocaleLowerCase('und')))) return false;
  }
  return true;
}

async function conversationEvidence(uid: string, dek: Buffer, conversations: ConversationDoc[], queryTerms: string[]): Promise<Evidence[]> {
  const cache = new Map<string, Promise<SegmentDoc[]>>();
  const segmentsFor = (recordingId: string) => {
    let value = cache.get(recordingId);
    if (!value) { value = db.listSegments(uid, recordingId); cache.set(recordingId, value); }
    return value;
  };

  const values = await Promise.all(conversations.map(async (conversation): Promise<Evidence | null> => {
    try {
      const content = openJson<{ title: string; summary: string }>(
        dek, conversation.sealedContent, binding(uid, `conversation/${conversation.conversationId}`, 'content'),
      );
      const segmentText: string[] = [];
      for (const segment of await segmentsFor(conversation.recordingId)) {
        if (!segment.sealedTranscript || segment.endMs < conversation.startMs || segment.startMs > conversation.endMs) continue;
        try {
          segmentText.push(openText(
            dek, segment.sealedTranscript,
            binding(uid, `recording/${conversation.recordingId}/segment/${segment.index}`, 'transcript'),
          ));
        } catch { /* one damaged window must not hide the remaining evidence */ }
      }
      const transcript = excerpt(segmentText.join('\n'), queryTerms);
      return {
        recordingId: conversation.recordingId,
        conversationId: conversation.conversationId,
        startMs: conversation.startMs,
        endMs: conversation.endMs,
        day: conversation.day,
        title: content.title || 'Recorded conversation',
        summary: [content.summary, transcript ? `Transcript evidence:\n${transcript}` : ''].filter(Boolean).join('\n\n'),
      };
    } catch { return null; }
  }));
  return values.filter((value): value is Evidence => Boolean(value));
}

async function transcriptEvidence(
  uid: string,
  dek: Buffer,
  query: string,
  queryTerms: string[],
  from: string | null | undefined,
  to: string | null | undefined,
  people: string[],
  topics: string[],
  intent: string,
  limit: number,
): Promise<Evidence[]> {
  const recordings = await db.listRecentRecordings(uid, MAX_RECENT_RECORDINGS);
  const candidates: { rank: number; evidence: Evidence }[] = [];
  const broadIntent = ['summary', 'decisions', 'commitments', 'people'].includes(intent);

  for (const recording of recordings) {
    if (!inDayScope(recording.day, from, to)) continue;
    const materialized = await materializeTranscript(uid, recording, dek);
    if (!materialized.text.trim()) continue;

    let memory: StructuredMemory | null = null;
    if (recording.sealedMemory) {
      try {
        memory = openJson<StructuredMemory>(
          dek, recording.sealedMemory, binding(uid, `recording/${recording.recordingId}`, 'memory'),
        );
      } catch { memory = null; }
    }
    if (!memoryScopeMatches(memory, people, topics, materialized.text)) continue;

    const memoryText = [memory?.title, memory?.executive_summary, ...(memory?.key_points || [])].filter(Boolean).join('\n');
    const lexical = score(`${memoryText}\n${materialized.text}`, queryTerms);
    const scopedRecall = broadIntent && Boolean(from || to || people.length || topics.length);
    if (lexical <= 0 && !scopedRecall) continue;

    candidates.push({
      rank: lexical + (materialized.complete ? 2 : 0) + (recording.state === 'ready' ? 1 : 0),
      evidence: {
        recordingId: recording.recordingId,
        conversationId: `recording-${recording.recordingId}`,
        startMs: 0,
        endMs: Math.max(0, recording.durationMs),
        day: recording.day,
        title: memory?.title?.trim() || 'Recorded conversation',
        summary: [
          memory?.executive_summary?.trim() || '',
          `Transcript evidence${materialized.complete ? '' : ' (processing may still be incomplete)'}:\n${excerpt(materialized.text, queryTerms)}`,
        ].filter(Boolean).join('\n\n'),
      },
    });
  }

  return candidates.sort((a, b) => b.rank - a.rank)
    .slice(0, Math.max(3, Math.min(limit * 2, 10)))
    .map((candidate) => candidate.evidence);
}

function dedupe(items: Evidence[], limit: number): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const item of items) {
    const key = `${item.recordingId}:${item.startMs}:${item.endMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function groundedFallback(evidence: Evidence[]) {
  const sources = evidence.slice(0, 3).map((item) => ({
    recording_id: item.recordingId,
    conversation_id: item.conversationId,
    start_ms: item.startMs,
    end_ms: item.endMs,
    quote: null,
  }));
  return {
    answer: 'I found relevant transcript evidence, but the answer synthesis service could not complete. Open the sources below to review the exact recording.',
    confidence: sources.length ? 'low' as const : 'none' as const,
    sources,
  };
}

/** Ask Synap v3: transcript evidence remains queryable even if memory/indexing failed. */
export function askV3Routes(): Router {
  const router = Router();
  router.post('/ask', requireAuth(), handler<AuthedRequest>(async (req, res) => {
    const body = askBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'bad_request', 'query is required');

    const { query, scope = {}, max_sources } = body.data;
    const limit = Math.min(max_sources ?? config.limits.maxAskSources, 20);
    const parsed = await parseQuery(query, new Date().toISOString().slice(0, 10));
    const peopleNames = [...new Set([...(scope.people ?? []), ...parsed.people])];
    const topics = [...new Set([...(scope.topics ?? []), ...parsed.topics])];
    const personIds: string[] = [];
    for (const name of peopleNames) {
      const person = await db.findPersonByNameKey(req.uid, nameKey(req.dek, name));
      if (person) personIds.push(person.personId);
    }
    const retrieval = {
      from: scope.from ?? parsed.from,
      to: scope.to ?? parsed.to,
      personIds,
      topicKeys: topics.map(topicKey).filter(Boolean),
    };

    let conversations: ConversationDoc[] = [];
    try {
      const vector = await embedContent(query, 'RETRIEVAL_QUERY');
      conversations = await db.findNearestConversations(req.uid, vector, limit * 2, retrieval);
    } catch {
      try {
        const recent = await db.recentConversations(req.uid, Math.max(limit * 8, 40), retrieval);
        conversations = recent.filter((conversation) => db.matchesScope(conversation, retrieval)).slice(0, limit * 2);
      } catch { conversations = []; }
    }

    const queryTerms = terms(query);
    const [semantic, transcript] = await Promise.all([
      conversationEvidence(req.uid, req.dek, conversations, queryTerms),
      transcriptEvidence(
        req.uid, req.dek, query, queryTerms, retrieval.from, retrieval.to,
        peopleNames, topics, parsed.intent, limit,
      ),
    ]);
    const evidence = dedupe([...semantic, ...transcript], Math.max(12, limit * 2));

    let answer;
    try {
      answer = await answerFromEvidence(query, evidence);
    } catch {
      answer = groundedFallback(evidence);
    }

    res.status(200).json({
      ...answer,
      searched: {
        conversations: evidence.length,
        semantic_conversations: semantic.length,
        transcript_matches: transcript.length,
        from: retrieval.from,
        to: retrieval.to,
        people: peopleNames.map(normalizeName),
      },
    });
  }));
  return router;
}
