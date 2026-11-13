import { describe, expect, it } from 'vitest';
import {
  INTERACTION_STATES,
  allowedEvents,
  canPublish,
  nextInteractionState,
  type InteractionState,
} from './interaction-state';

describe('máquina de estados de interacción', () => {
  it('no permite publicar sin aprobación', () => {
    const nonApproved = INTERACTION_STATES.filter(
      (s) => s !== 'approved' && s !== 'publish_failed',
    );
    for (const s of nonApproved) {
      expect(nextInteractionState(s, 'publish_started')).toBeNull();
      expect(canPublish(s)).toBe(false);
    }
    expect(nextInteractionState('approved', 'publish_started')).toBe('publishing');
  });

  it('editar tras aprobar invalida la aprobación', () => {
    expect(nextInteractionState('approved', 'draft_edited')).toBe('draft_generated');
    expect(nextInteractionState('pending_approval', 'draft_edited')).toBe('draft_generated');
  });

  it('una respuesta publicada es terminal (evita doble publicación)', () => {
    expect(allowedEvents('published')).toEqual([]);
  });

  it('el reintento solo es posible tras un error de publicación', () => {
    expect(nextInteractionState('publish_failed', 'retry_publish')).toBe('publishing');
    expect(nextInteractionState('published', 'retry_publish')).toBeNull();
    expect(nextInteractionState('publishing', 'retry_publish')).toBeNull();
  });

  it('todas las transiciones apuntan a estados válidos', () => {
    for (const s of INTERACTION_STATES) {
      for (const e of allowedEvents(s)) {
        expect(INTERACTION_STATES).toContain(nextInteractionState(s, e) as InteractionState);
      }
    }
  });

  it('el estado publicado solo es alcanzable desde publishing', () => {
    for (const s of INTERACTION_STATES) {
      for (const e of allowedEvents(s)) {
        if (nextInteractionState(s, e) === 'published') expect(s).toBe('publishing');
      }
    }
  });
});
