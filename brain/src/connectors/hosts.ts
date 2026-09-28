/** Org rule: never connect to production hosts. A host is denied if it equals an entry or ends with "." + entry. */
export const DEFAULT_DENYLIST: readonly string[] = ['int.meesho.int', 'prd.meesho.int', 'int.mrouter.int', 'prd.mrouter.int'];

export function isDeniedHost(url: string, denylist: readonly string[] = DEFAULT_DENYLIST): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  return denylist.some((d) => host === d || host.endsWith(`.${d}`));
}
