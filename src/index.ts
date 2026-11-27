export { AuthStore } from './auth/auth-do';
export { TusUpload } from './tus/upload-do';
import { handleRequest } from './router';

export default { fetch: handleRequest };
