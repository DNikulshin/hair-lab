'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { consumeMagicLink } from '../api/auth-api';

type State = 'pending' | 'failed';

export function MagicLinkConsumer({ token }: { token: string | null }) {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<State>('pending');

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (token === null) {
      setState('failed');
      return;
    }

    void consumeMagicLink(token).then((result) => {
      if (result.ok) {
        router.replace('/');
        router.refresh();
      } else {
        setState('failed');
      }
    });
  }, [router, token]);

  if (state === 'pending') {
    return <p role="status" className="text-sm text-muted">Проверяем ссылку…</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p role="alert" className="text-sm text-red-600">
        Ссылка недействительна или срок её действия истёк. Запросите новую.
      </p>
      <Link href="/login" className="w-fit text-sm underline">
        Вернуться ко входу
      </Link>
    </div>
  );
}
