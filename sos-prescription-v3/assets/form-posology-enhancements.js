(function () {
  'use strict';

  /**
   * v3.2.9 - Hard isolation hotfix
   *
   * Le bundle React/Vite du formulaire est identique entre la V2 stable et la V3.
   * Le seul delta sur le chemin "clic médicament -> rendu posologie" est ce script
   * de patch runtime. Pour appliquer la "Zero Crash Policy", on le neutralise
   * totalement : aucun MutationObserver, aucun scan DOM, aucun listener global.
   *
   * Le bundle React garde seul le contrôle du sous-arbre formulaire.
   */

  if (typeof window !== 'undefined') {
    window.__SOSPrescriptionPosologyEnhancementsDisabled = true;
  }
})();
