import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { openJson, openText } from '../../crypto/envelope.js';
import { answerFromEvidence, parseQuery, type Evidence } from '../../gemini/ask.js';
import { embedContent } from '../../gemini/client.js';
import { binding } from '../../pipeline/process.js';
import * as db from '../../store/firestore.js';
import type { ConversationDoc, RecordingDoc, SegmentDoc, StructuredMemory } from '../../store/types.js';
import { nameKey, normalizeName, topicKey } from '../../util/ids.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import { HttpError, handler } from '../errors.js';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RECENT_RECORDINGS = 80;
const MAX_TRANSCRIPT_EXCERPT = 5_000;

const askBody = z.object({
  query: z.string().min(1).max(1000),
  scope: z
    .object({
      from: z.string().regex(DAY_PATTERN).nullable().optional(),
      to: z.string().regex(DAY_PATTERN).nullable().optional(),
      people: z.array(z.string()).max(10).optional(),
      topics: z.array(z.string()).max(10).optional(),
    })
    .optional(),
  max_sources: z.number().int().min(1).max(20).optional(),
});

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'what', 'when', 'where', 'which', 'who', 'why', 'how',
  'did', 'does', 'was', 'were', 'are', 'about', 'from', 'have', 'has', 'had', 'said', 'say', 'tell',
  'me', 'my', 'our', 'your', 'his', 'her', 'their', 'they', 'them', 'you', 'can', 'could', 'would',
  'kya', 'hai', 'tha', 'thi', 'the', 'mein', 'main', 'ka', 'ki', 'ke', 'ko', 'se', 'aur', 'par', 'ne',
]);

function queryTerms(value: string): string[] {
  const terms = String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
  return [...new Set(terms)].slice(0, 20);
}

function lexicalScore(text: string, terms: string[]): number {
  if (!text || terms.length === 0) return 0;
  const haystack = text.normalize('NFKC').toLocaleLowerCase('und');
  let score = 0;
  for (const term of terms) {
    let at = haystack.indexOf(term);
    let hits = 0;
    while (at !== -1 && hits < 8) {
      hits += 1;
      score += hits === 1 ? 3 : 1;
      at = haystack.indexOf(term, at + term.length);
    }
  }
  return score;
}

function excerptAroundTerms(text: string, terms: string[], max = MAX_TRANSCRIPT_EXCERPT): string {
  const clean = String(text || '').trim();
  if (clean.length <= max) return clean;
  const lower = clean.normalize('NFKC').toLocaleLowerCase('und');
  const positions = terms
    .map((term) => lower.indexOf(term))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b);
  const focus = positions[0] ?? Math.floor(clean.length / 2);
  const start = Math.max(0, Math.min(clean.length - max, focus - Math.floor(max * 0.35)));
  const end = Math.min(clean.length, start + max);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}

function recordingInScope(recording: RecordingDoc, from?: string | null, to?: string | null): boolean {
  if (from && recording.day < from) return false;
  if (to && recording.day > to) return false;
  return true;
}

function memoryMatchesStructuredScope(
  memory: StructuredMemory | null,
  people: string[],
  topics: string[],
): boolean {
  if (!memory) return people.length === 0 && topics.length === 0;
  if (people.length) {
    const present = new Set((memory.people || []).map((person) => normalizeName(person.name)));
    if (!people.some((name) => present.has(normalizeName(name)))) return false;
  }
  if (topics.length) {
    const present = new Set((memory.topics || []).map(topicKey).filter(Boolean));
    if (!topics.some((topic) => present.has(topicKey(topic)))) return false;
  }
  return true;
}

async function conversationEvidence(
  uid: string,
  dek: Buffer,
  conversations: ConversationDoc[],
  terms: string[],
): Promise<Evidence[]> {
  const segmentCache = new Map<string, Promise<SegmentDoc[]>>();
  const segmentsFor = (recordingId: string) => {
    let pending = segmentCache.get(recordingId);
    if (!pending) {
      pending = db.listSegments(uid, recordingId);
      segmentCache.set(recordingId, pending);
    }
    return pending;
  };

  const built = await Promise.all(
    conversations.map(async (conversation): Promise<Evidence | null> => {
      try {
        const content = openJson<{ title: string; summary: string }>(
          dek,
          conversation.sealedContent,
          binding(uid, `conversation/${conversation.conversationId}`, 'content'),
        );
        const segments = await segmentsFor(conversation.recordingId);
        const transcript = segments
          .filter((segment) =>
            Boolean(segment.sealedTranscript) &&
            segment.endMs >= conversation.startMs &&
            segment.startMs <= conversation.endMs,
          )
          .map((segment) => {
            try {
              return openText(
                dek,
                segment.sealedTranscript!,
                binding(uid, `recording/${conversation.recordingId}/segment/${segment.index}`, 'transcript'),
              ).trim();
            } catch {
              return '';
            }
          })
          .filter(Boolean)
          .join('\n');
        const excerpt = excerptAroundTerms(transcript, terms);
        const grounded = [content.summary?.trim(), excerpt ? `Transcript evidence:\n${excerpt}` : '']
          .filter(Boolean)
          .join('\n\n');
        return {
          recordingId: conversation.recordingId,
          conversationId: conversation.conversationId,
          startMs: conversation.startMs,
          endMs: conversation.endMs,
          day: conversation.day,
          title: content.title,
          summary: grounded,
        };
      } catch {
        return null;
      }
    }),
  );
  return built.filter((item): item is Evidence => Boolean(item));
}

async function lexicalRecordingEvidence(
  uid: string,
  dek: Buffer,
  query: string,
  terms: string[],
  from: string | null | undefined,
  to: string | null | undefined,
  people: string[],
  topics: string[],
  limit: number,
): Promise<Evidence[]> {
  if (terms.length === 0) return [];
  const recordings = await db.listRecentRecordings(uid, MAX_RECENT_RECORDINGS);
  const candidates: { score: number; evidence: Evidence }[] = [];

  for (const recording of recordings) {
    if (recording.state !== 'ready' || !recording.sealedTranscript) continue;
    if (!recordingInScope(recording, from, to)) continue;

    try {
      const transcript = openText(
        dek,
        recording.sealedTranscript,
        binding(uid, `recording/${recording.recordingId}`, 'transcript'),
      );
      let memory: StructuredMemory | null = null;
      if (recording.sealedMemory) {
        try {
          memory = openJson<StructuredMemory>(
            dek,
            recording.sealedMemory,
            binding(uid, `recording/${recording.recordingId}`, 'memory'),
          );
        } catch {
          memory = null;
        }
      }
      if (!memoryMatchesStructuredScope(memory, people, topics)) continue;

      const score = lexicalScore(transcript, terms);
      if (score <= 0) continue;
      const excerpt = excerptAroundTerms(transcript, terms);
      const memorySummary = memory?.executive_summary?.trim() || '';
      candidates.push({
        score,
        evidence: {
          recordingId: recording.recordingId,
          conversationId: `recording-${recording.recordingId}`,
          startMs: 0,
          endMs: Math.max(0, recording.durationMs),
          day: recording.day,
          title: memory?.title?.trim() || 'Recorded conversation',
          summary: [memorySummary, `Transcript evidence:\n${excerpt}`].filter(Boolean).join('\n\n'),
        },
      });
    } catch {
      // A single unreadable historical recording must not break Ask Synap.
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(2, Math.min(limit, 6)))
    .map((candidate) => candidate.evidence);
}

function dedupeEvidence(items: Evidence[], max: number): Evidence[] {
  const seen = new Set<string>();
  const result: Evidence[] = [];
  for (const item of items) {
    const key = `${item.recordingId}:${item.startMs}:${item.endMs}:${item.summary.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= max) break;
  }
  return result;
}

/**
 * Ask Synap v2 keeps the existing semantic index, but grounds the answer in the
 * actual encrypted transcript windows instead of summaries alone. Historical
 * recordings are immediately useful: a small lexical pass over recent sealed
 * full transcripts supplements semantic retrieval without requiring a reindex
 * or a new Firestore index.
 */
export function askV2Routes(): Router {
  const router = Router();

  router.post(
    '/ask',
    requireAuth(),
    handler<AuthedRequest>(async (req, res) => {
      const body = askBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'query is required');

      const { query, scope = {}, max_sources } = body.data;
      const limit = Math.min(max_sources ?? config.limits.maxAskSources, 20);
      const today = new Date().toISOString().slice(0, 10);
      const parsed = await parseQuery(query, today);
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
        } catch {
          conversations = [];
        }
      }

      const terms = queryTerms(query);
      const semantic = await conversationEvidence(req.uid, req.dek, conversations, terms);
      const lexical = await lexicalRecordingEvidence(
        req.uid,
        req.dek,
        query,
        terms,
        retrieval.from,
        retrieval.to,
        peopleNames,
        topics,
        limit,
      );
      const evidence = dedupeEvidence([...semantic, ...lexical], Math.max(limit * 2, 12));
      const answer = await answerFromEvidence(query, evidence);

      res.status(200).json({
        ...answer,
        searched: {
          conversations: evidence.length,
          semantic_conversations: semantic.length,
          transcript_matches: lexical.length,
          from: retrieval.from,
          to: retrieval.to,
          people: peopleNames.map(normalizeName),
        },
      });
    }),
  );

  return router;
}
