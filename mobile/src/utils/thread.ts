import { v5 as uuidv5 } from 'uuid';

export const AISIST_NAMESPACE = 'e587b8a0-3e1a-4c5d-9f2b-1a8c4d6e7f90';

export function generateThreadId(email: string): string {
  return uuidv5(email, AISIST_NAMESPACE);
}
