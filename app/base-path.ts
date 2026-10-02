/** The app's URL prefix ("/notes"). Prepend it to fetch() URLs; <Link> adds it on its own. */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
export const api = (path: string) => `${BASE_PATH}${path}`;
