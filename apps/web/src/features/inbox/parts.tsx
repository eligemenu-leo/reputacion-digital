import { FlaskConical, Star } from 'lucide-react';
import { Badge } from '@/components/ui/misc';
import {
  PRIORITY_TONE,
  RISK_LABELS,
  SENTIMENT_TONE,
  STATE_TONE,
  priorityLabel,
  stateLabel,
} from '@/lib/inbox';
import { SENTIMENT_LABELS_ES, type InteractionState, type Sentiment } from '@rep/shared';

export function StateBadge({ state }: { state: InteractionState }) {
  return <Badge tone={STATE_TONE[state]}>{stateLabel(state)}</Badge>;
}

export function PriorityBadge({ priority }: { priority: number }) {
  return <Badge tone={PRIORITY_TONE[priority] ?? 'neutral'}>{priorityLabel(priority)}</Badge>;
}

/** Etiqueta visible en todo dato ficticio del simulador. */
export function SimulatedBadge() {
  return (
    <Badge tone="accent" className="uppercase tracking-wide">
      <FlaskConical className="size-3" aria-hidden />
      Simulado
    </Badge>
  );
}

export function RiskBadges({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <>
      {flags.map((f) => (
        <Badge key={f} tone="danger">
          {RISK_LABELS[f] ?? f}
        </Badge>
      ))}
    </>
  );
}

export function Stars({ rating, scale }: { rating: string | null; scale: number | null }) {
  if (rating == null) return <span className="text-xs text-muted">Sin valoración</span>;
  const value = Number(rating);
  const max = scale ?? 5;
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value} de ${max} estrellas`}>
      {Array.from({ length: max }).map((_, i) => (
        <Star
          key={i}
          aria-hidden
          className={
            i < Math.round(value) ? 'size-3.5 fill-warning text-warning' : 'size-3.5 text-border'
          }
        />
      ))}
    </span>
  );
}

export function SentimentBadge({ sentiment }: { sentiment: Sentiment | null }) {
  if (!sentiment) return null;
  return <Badge tone={SENTIMENT_TONE[sentiment]}>{SENTIMENT_LABELS_ES[sentiment]}</Badge>;
}
