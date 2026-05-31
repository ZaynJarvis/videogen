import { useCallback, useState } from 'react';

export function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);
  const node = toast ? <div className="toast">{toast}</div> : null;
  return { show, node };
}
