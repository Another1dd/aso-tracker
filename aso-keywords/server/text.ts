/** Lower-cased, NFKC-normalised, single-spaced text: the key under which hints and phrases are compared. */
export const normalizeHint = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
