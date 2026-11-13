import { Construction } from 'lucide-react';
import { Card, EmptyState, PageHeader } from '@/components/ui/misc';

export function ComingSoonPage({
  title,
  phase,
  description,
}: {
  title: string;
  phase: string;
  description: string;
}) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <EmptyState
          icon={<Construction className="size-5" aria-hidden />}
          title={`Disponible en ${phase}`}
          description={description}
        />
      </Card>
    </>
  );
}
