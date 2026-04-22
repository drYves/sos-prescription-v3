import '../runtime/installFetchPatch';
import { installDoctorMessagingShellBridge } from './doctorMessagingShellBridge';

try {
  installDoctorMessagingShellBridge();
} catch {
  // Fail-closed: si l'environnement ne permet pas d'écrire sur window, on n'explose pas.
}
