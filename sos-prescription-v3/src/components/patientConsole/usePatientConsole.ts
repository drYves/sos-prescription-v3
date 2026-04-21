import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RequestListPanelRow } from './RequestListPanel';
import {
  type AppConfig,
  type PatientProfileSnapshot,
  type PrescriptionSummary,
  type PrescriptionFile,
  type PrescriptionDetail,
  type MessageItem,
  type PdfState,
  ApiPayloadError,
  getAppConfig,
  toPositiveInteger,
  cleanHumanText,
  formatHumanDate,
  buildPrescriptionTitle,
  formatFileSize,
  isPatientProfileComplete,
  debugApiPayload,
  extractApiCode,
  normalizePrescriptionSummaryArray,
  normalizePrescriptionDetail,
  mergeNormalizedMessages,
  normalizeMessageArray,
  normalizePdfState,
  resolveUnknownErrorMessage,
  resolveBannerFromPayload,
  resolveBannerFromError,
  buildPatientProfileSeed,
  normalizePatientPulseResponse,
  applyPulseToSummaries,
  openPresignedPdf,
  normalizeStatusValue,
  resolvePatientMessagingState,
  patientMessagingReadOnlyNotice,
  patientMessagingEmptyText,
  statusTone,
  statusInfo,
  filePurposeLabel,
} from '../PatientConsole';

type UsePatientConsoleArgs = {
  cfg: AppConfig;
  isLoggedIn: boolean;
  listPatientPrescriptions: () => Promise<unknown>;
  getPatientPulse: (knownCollectionHash?: string) => Promise<unknown>;
  getPatientPrescription: (id: number) => Promise<unknown>;
  getPatientMessages: (id: number) => Promise<unknown>;
  getPatientPdfStatus: (id: number) => Promise<unknown>;
  downloadProtectedFile: (url: string, filename: string) => Promise<void>;
};

export default function usePatientConsole({
  cfg,
  isLoggedIn,
  listPatientPrescriptions,
  getPatientPulse,
  getPatientPrescription,
  getPatientMessages,
  getPatientPdfStatus,
  downloadProtectedFile,
}: UsePatientConsoleArgs) {
  const [prescriptions, setPrescriptions] = useState<PrescriptionSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PrescriptionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiBanner, setApiBanner] = useState<string | null>(null);
  const [pdfStates, setPdfStates] = useState<Record<number, PdfState>>({});
  const [pdfDownloadBusyId, setPdfDownloadBusyId] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<'requests' | 'profile'>('requests');
  const [profileSnapshot, setProfileSnapshot] = useState<PatientProfileSnapshot>(() => ({
    patientProfile: cfg.patientProfile,
    currentUser: cfg.currentUser,
  }));
  const [profileCompletenessResolved, setProfileCompletenessResolved] = useState<boolean>(() => isPatientProfileComplete(cfg.patientProfile, cfg.currentUser));

  const prescriptionsRef = useRef<PrescriptionSummary[]>([]);
  const selectedIdRef = useRef<number | null>(null);
  const pulseCollectionHashRef = useRef<string>('');
  const pulseInFlightRef = useRef(false);
  const pulseTimerRef = useRef<number | null>(null);
  const listRequestSeqRef = useRef(0);
  const detailRequestSeqRef = useRef(0);
  const messagesRequestSeqRef = useRef(0);

  const requestedId = useMemo(() => {
    try {
      const search = new URLSearchParams(window.location.search);
      const value = Number.parseInt(search.get('rx') || '', 10);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    prescriptionsRef.current = prescriptions;
  }, [prescriptions]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const clearPulseTimer = useCallback((): void => {
    if (pulseTimerRef.current !== null) {
      window.clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn) {
      clearPulseTimer();
      pulseCollectionHashRef.current = '';
      pulseInFlightRef.current = false;
      setPrescriptions([]);
      setSelectedId(null);
      setDetail(null);
      setMessages([]);
      setPdfStates({});
      setPdfDownloadBusyId(null);
    }
  }, [clearPulseTimer, isLoggedIn]);

  useEffect(() => {
    const handlePatientProfileUpdated = (event: Event): void => {
      const detail = event instanceof CustomEvent
        ? (event.detail as { profile?: AppConfig['patientProfile'] } | undefined)
        : undefined;
      const nextConfig = getAppConfig();
      setProfileSnapshot({
        patientProfile: detail?.profile || nextConfig.patientProfile,
        currentUser: nextConfig.currentUser,
      });
    };

    window.addEventListener('sosprescription:patient-profile-updated', handlePatientProfileUpdated as EventListener);
    return () => {
      window.removeEventListener('sosprescription:patient-profile-updated', handlePatientProfileUpdated as EventListener);
    };
  }, []);

  const handleProfileChange = useCallback((profile: AppConfig['patientProfile']): void => {
    const nextConfig = getAppConfig();
    setProfileSnapshot({
      patientProfile: { ...(nextConfig.patientProfile || {}), ...(profile || {}) },
      currentUser: nextConfig.currentUser,
    });
    setProfileCompletenessResolved(true);
  }, []);

  const selectedSummary = useMemo(
    () => prescriptions.find((row) => Number(row.id) === Number(selectedId)) || null,
    [prescriptions, selectedId]
  );

  const profileComplete = useMemo(
    () => isPatientProfileComplete(profileSnapshot.patientProfile, profileSnapshot.currentUser),
    [profileSnapshot.currentUser, profileSnapshot.patientProfile]
  );
  const profileBadgeLabel = profileCompletenessResolved
    ? (profileComplete ? 'Complet' : 'À compléter')
    : '';
  const profileBadgeState = profileComplete ? 'success' : 'warning';

  const paymentProfileSeed = useMemo(
    () => buildPatientProfileSeed(profileSnapshot.patientProfile, profileSnapshot.currentUser),
    [profileSnapshot.currentUser, profileSnapshot.patientProfile]
  );
  const paymentBillingName = useMemo(() => {
    const combined = cleanHumanText([paymentProfileSeed.first_name, paymentProfileSeed.last_name].filter(Boolean).join(' '));
    return combined
      || cleanHumanText(profileSnapshot.patientProfile?.fullname)
      || cleanHumanText(profileSnapshot.patientProfile?.full_name)
      || cleanHumanText(profileSnapshot.patientProfile?.fullName)
      || cleanHumanText(profileSnapshot.currentUser?.displayName)
      || undefined;
  }, [
    paymentProfileSeed.first_name,
    paymentProfileSeed.last_name,
    profileSnapshot.currentUser?.displayName,
    profileSnapshot.patientProfile?.fullName,
    profileSnapshot.patientProfile?.full_name,
    profileSnapshot.patientProfile?.fullname,
  ]);
  const paymentBillingEmail = useMemo(() => {
    const email = cleanHumanText(profileSnapshot.patientProfile?.email)
      || cleanHumanText(profileSnapshot.currentUser?.email)
      || cleanHumanText(paymentProfileSeed.email);
    return email || undefined;
  }, [paymentProfileSeed.email, profileSnapshot.currentUser?.email, profileSnapshot.patientProfile?.email]);

  const selectedStatus = normalizeStatusValue(selectedSummary?.status || detail?.status || '');
  const selectedPdf = selectedId ? pdfStates[selectedId] || null : null;
  const activePayment = useMemo(() => {
    if (!selectedSummary?.payment && !detail?.payment) {
      return undefined;
    }

    return {
      ...(detail?.payment || {}),
      ...(selectedSummary?.payment || {}),
    };
  }, [detail?.payment, selectedSummary?.payment]);
  const selectedPaymentPriority = normalizeStatusValue(String(activePayment?.priority || selectedSummary?.priority || detail?.priority || ''));
  const requestTitle = useMemo(
    () => buildPrescriptionTitle(detail?.primary_reason || selectedSummary?.primary_reason, detail?.created_at || selectedSummary?.created_at || ''),
    [detail?.created_at, detail?.primary_reason, selectedSummary?.created_at, selectedSummary?.primary_reason]
  );
  const requestDetails = detail?.request_details || [];
  const messagingState = useMemo(
    () => (selectedId ? resolvePatientMessagingState(selectedStatus, messages) : 'WAITING_DOCTOR'),
    [messages, selectedId, selectedStatus]
  );
  const messagingLocked = messagingState !== 'OPEN';
  const messagingReadOnlyNotice = selectedId
    ? patientMessagingReadOnlyNotice(selectedStatus, messagingState)
    : "Le médecin n'a pas encore sollicité d'information pour ce dossier.";
  const messagingEmptyText = selectedId
    ? patientMessagingEmptyText(selectedStatus, messagingState)
    : "Le médecin n'a pas encore sollicité d'information. Cet espace s'ouvrira automatiquement dès qu'un message médical sera envoyé.";
  const messagingSubtitle = messagingState === 'OPEN'
    ? 'Messagerie sécurisée associée à votre dossier.'
    : '';
  const unreadPatientMessages = toPositiveInteger(selectedSummary?.unread_count_patient);
  const messagingDisclosureDefaultOpen = unreadPatientMessages > 0 || messagingState === 'OPEN';
  const messagingDisclosureSummary = unreadPatientMessages > 1
    ? `${unreadPatientMessages} messages non lus`
    : unreadPatientMessages === 1
      ? '1 message non lu'
      : '';
  const messagingDisclosureResetKey = `patient-thread-${detail?.id || selectedId || 0}-${messagingDisclosureDefaultOpen ? 'open' : 'closed'}-${unreadPatientMessages}`;

  const fileIndex = useMemo(() => {
    const index: Record<number, PrescriptionFile> = {};
    (detail?.files || []).forEach((file) => {
      index[file.id] = file;
    });
    return index;
  }, [detail?.files]);

  const detailDocumentRows = (detail?.files || []).map((file) => ({
    id: file.id,
    originalName: file.original_name,
    meta: `${filePurposeLabel(file.purpose)} • ${formatFileSize(file.size_bytes)}`,
    downloadUrl: file.download_url,
  }));

  const detailMedicationRows = (detail?.items || []).map((item, index) => ({
    key: `${item.denomination}-${index}`,
    denomination: item.denomination,
    posologie: item.posologie,
    quantite: item.quantite,
  }));

  const requestListRows: RequestListPanelRow[] = prescriptions.map((row) => {
    const info = statusInfo(row.status);

    return {
      id: Number(row.id),
      selected: Number(row.id) === Number(selectedId),
      statusLabel: info.label,
      statusTone: statusTone(row.status),
      title: buildPrescriptionTitle(row.primary_reason, row.created_at),
      createdAtLabel: formatHumanDate(row.created_at),
    };
  });

  const refreshList = useCallback(async ({ silent = false }: { silent?: boolean } = {}): Promise<void> => {
    const requestSeq = ++listRequestSeqRef.current;

    if (!silent) {
      setError(null);
      setApiBanner(null);
      setListLoading(true);
    }

    try {
      const payload = await listPatientPrescriptions();
      if (!Array.isArray(payload)) {
        debugApiPayload(payload, {
          endpoint: '/prescriptions',
          expected: 'array',
          received_type: typeof payload,
        });

        const banner = resolveBannerFromPayload(payload);
        if (!silent && banner) {
          setApiBanner(banner);
          setError(null);
        } else if (!silent) {
          setError('Réponse API inattendue pour la liste des demandes. Consultez la console pour le payload brut.');
        }
        return;
      }

      const rows = normalizePrescriptionSummaryArray(payload);
      setPrescriptions((current) => {
        const index = new Map<number, PrescriptionSummary>();
        current.forEach((row) => {
          index.set(Number(row.id), row);
        });

        return rows.map((row) => {
          const existing = index.get(Number(row.id));
          if (!existing) {
            return row;
          }

          return {
            ...row,
            status: existing.status || row.status,
            primary_reason: row.primary_reason || existing.primary_reason,
            row_rev: existing.row_rev,
            updated_at: existing.updated_at,
            last_activity_at: existing.last_activity_at,
            processing_status: existing.processing_status,
            message_count: existing.message_count,
            last_message_seq: existing.last_message_seq,
            unread_count_patient: existing.unread_count_patient,
            has_proof: existing.has_proof,
            proof_count: existing.proof_count,
            pdf_ready: existing.pdf_ready,
            payment: existing.payment,
          };
        });
      });

      setSelectedId((current) => {
        if (current && rows.some((row) => Number(row.id) === Number(current))) {
          return current;
        }
        if (requestedId && rows.some((row) => Number(row.id) === Number(requestedId))) {
          return requestedId;
        }
        return rows.length > 0 ? Number(rows[0].id) : null;
      });

      if (rows.length < 1 && !silent) {
        setDetail(null);
        setMessages([]);
      }
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (!silent && banner) {
        setApiBanner(banner);
        setError(null);
      } else if (!silent) {
        setError(resolveUnknownErrorMessage(err, 'Erreur chargement'));
      }
    } finally {
      if (!silent && listRequestSeqRef.current === requestSeq) {
        setListLoading(false);
      }
    }
  }, [listPatientPrescriptions, requestedId]);

  const loadDetail = useCallback(async (id: number, silent = false): Promise<void> => {
    const requestSeq = ++detailRequestSeqRef.current;

    if (!silent) {
      setError(null);
      setApiBanner(null);
      setDetailLoading(true);
    }

    try {
      const payload = await getPatientPrescription(id);
      const normalized = normalizePrescriptionDetail(payload);

      if (!normalized) {
        debugApiPayload(payload, {
          endpoint: `/prescriptions/${id}`,
          expected: 'object',
          received_type: typeof payload,
        });
        const banner = resolveBannerFromPayload(payload);
        if (!silent && banner) {
          setApiBanner(banner);
          setError(null);
        } else if (!silent) {
          setError('Réponse API inattendue sur le détail patient. Consultez la console pour le payload brut.');
        }
        if (!silent && selectedIdRef.current === id) {
          setDetail(null);
        }
        return;
      }

      if (selectedIdRef.current !== id) {
        return;
      }

      setDetail(normalized);
      setPrescriptions((current) => current.map((row) => {
        if (Number(row.id) !== Number(normalized.id)) {
          return row;
        }

        return {
          ...row,
          created_at: normalized.created_at || row.created_at,
          primary_reason: normalized.primary_reason || row.primary_reason,
          payment: normalized.payment || row.payment,
        };
      }));
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (!silent && banner) {
        setApiBanner(banner);
        setError(null);
      } else if (!silent) {
        setError(resolveUnknownErrorMessage(err, 'Erreur chargement'));
      }
      if (!silent && selectedIdRef.current === id) {
        setDetail(null);
      }
    } finally {
      if (!silent && detailRequestSeqRef.current === requestSeq) {
        setDetailLoading(false);
      }
    }
  }, [getPatientPrescription]);

  const loadMessages = useCallback(async (id: number, silent = false): Promise<void> => {
    const requestSeq = ++messagesRequestSeqRef.current;

    if (!silent) {
      setError(null);
      setApiBanner(null);
      setMessagesLoading(true);
    }

    try {
      const payload = await getPatientMessages(id);
      const messagesArray = Array.isArray(payload)
        ? payload
        : (payload && typeof payload === 'object' && 'messages' in payload ? (payload as { messages?: unknown }).messages : payload);

      if (!Array.isArray(messagesArray)) {
        debugApiPayload(payload, {
          endpoint: `/prescriptions/${id}/messages`,
          expected: 'array | { messages: array }',
          received_type: typeof payload,
        });
        const banner = resolveBannerFromPayload(payload);
        if (!silent && banner) {
          setApiBanner(banner);
          setError(null);
        } else if (!silent) {
          setError('Réponse API inattendue sur la messagerie. Consultez la console pour le payload brut.');
        }
        if (!silent && selectedIdRef.current === id) {
          setMessages([]);
        }
        return;
      }

      const normalizedMessages = normalizeMessageArray(messagesArray).filter((message) => {
        const normalizedRole = normalizeMessageAuthorRole(message.author_role);
        if (normalizedRole === 'PATIENT' || normalizedRole === 'DOCTOR') {
          return true;
        }

        return String(message.body || '').trim() !== '' || (Array.isArray(message.attachments) && message.attachments.length > 0);
      });

      if (selectedIdRef.current !== id) {
        return;
      }

      setMessages(normalizedMessages);
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (!silent && banner) {
        setApiBanner(banner);
        setError(null);
      } else if (!silent) {
        setError(resolveUnknownErrorMessage(err, 'Erreur messagerie'));
      }
      if (!silent && selectedIdRef.current === id) {
        setMessages([]);
      }
    } finally {
      if (!silent && messagesRequestSeqRef.current === requestSeq) {
        setMessagesLoading(false);
      }
    }
  }, [getPatientMessages]);

  const loadPdfStatus = useCallback(async (id: number, silent = false): Promise<void> => {
    try {
      const payload = await getPatientPdfStatus(id);
      const banner = resolveBannerFromPayload(payload);
      if (!silent && banner) {
        setApiBanner(banner);
        setError(null);
      }
      setPdfStates((current) => ({
        ...current,
        [id]: normalizePdfState(payload),
      }));
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (!silent && banner) {
        setApiBanner(banner);
        setError(null);
      } else if (!silent) {
        setError(resolveUnknownErrorMessage(err, 'Erreur document'));
      }

      if (!silent) {
        setPdfStates((current) => ({
          ...current,
          [id]: {
            status: 'failed',
            message: 'Impossible de récupérer le statut PDF.',
            last_error_message: resolveUnknownErrorMessage(err, 'Erreur document'),
            last_error_code: err instanceof ApiPayloadError ? extractApiCode(err.payload) || null : null,
          },
        }));
      }
    }
  }, [getPatientPdfStatus]);

  const syncPulse = useCallback(async (): Promise<void> => {
    if (!isLoggedIn || pulseInFlightRef.current) {
      return;
    }

    pulseInFlightRef.current = true;
    try {
      const knownCollectionHash = pulseCollectionHashRef.current || undefined;
      const payload = await getPatientPulse(knownCollectionHash);
      const normalized = normalizePatientPulseResponse(payload);
      if (!normalized) {
        debugApiPayload(payload, {
          endpoint: '/patient/pulse',
          expected: 'pulse payload',
        });
        return;
      }

      pulseCollectionHashRef.current = normalized.collection_hash;
      if (normalized.unchanged) {
        return;
      }

      const previousRows = prescriptionsRef.current;
      const previousMap = new Map<number, PrescriptionSummary>();
      previousRows.forEach((row) => {
        previousMap.set(Number(row.id), row);
      });

      const nextMap = new Map<number, (typeof normalized.items)[number]>();
      normalized.items.forEach((item) => {
        nextMap.set(Number(item.id), item);
      });

      setPrescriptions((current) => applyPulseToSummaries(current, normalized.items));

      let shouldReloadList = normalized.count !== previousRows.length;
      if (!shouldReloadList) {
        for (const item of normalized.items) {
          if (!previousMap.has(Number(item.id))) {
            shouldReloadList = true;
            break;
          }
        }
      }
      if (!shouldReloadList) {
        for (const row of previousRows) {
          if (!nextMap.has(Number(row.id))) {
            shouldReloadList = true;
            break;
          }
        }
      }

      if (shouldReloadList) {
        await refreshList({ silent: true });
      }

      const activeId = selectedIdRef.current;
      if (!activeId) {
        return;
      }

      const previousActive = previousMap.get(Number(activeId));
      const nextActive = nextMap.get(Number(activeId));
      if (!nextActive) {
        return;
      }

      const detailChanged = !previousActive || nextActive.row_rev !== previousActive.row_rev;
      const activityChanged = !previousActive
        || nextActive.last_activity_at !== previousActive.last_activity_at
        || nextActive.last_message_seq !== previousActive.last_message_seq
        || nextActive.message_count !== previousActive.message_count
        || nextActive.unread_count_patient !== previousActive.unread_count_patient;
      const pdfChanged = !previousActive
        || nextActive.status !== previousActive.status
        || Boolean(nextActive.pdf_ready) !== Boolean(previousActive.pdf_ready)
        || nextActive.updated_at !== previousActive.updated_at
        || nextActive.processing_status !== previousActive.processing_status;

      if (detailChanged) {
        await loadDetail(activeId, true);
      }
      if (activityChanged) {
        await loadMessages(activeId, true);
      }
      if (normalizeStatusValue(nextActive.status) === 'approved' && (pdfChanged || detailChanged)) {
        await loadPdfStatus(activeId, true);
      }

      if (
        previousActive
        && normalizeStatusValue(previousActive.status) === 'approved'
        && normalizeStatusValue(nextActive.status) !== 'approved'
      ) {
        setPdfStates((current) => {
          if (!(activeId in current)) {
            return current;
          }
          const next = { ...current };
          delete next[activeId];
          return next;
        });
      }
    } catch {
      // silent refresh must never destabilize the current UI snapshot
    } finally {
      pulseInFlightRef.current = false;
    }
  }, [getPatientPulse, isLoggedIn, loadDetail, loadMessages, loadPdfStatus, refreshList]);

  useEffect(() => {
    if (!isLoggedIn) {
      return;
    }

    let disposed = false;
    void (async () => {
      await refreshList();
      if (!disposed) {
        await syncPulse();
      }
    })();

    return () => {
      disposed = true;
    };
  }, [isLoggedIn, refreshList, syncPulse]);

  useEffect(() => {
    if (!isLoggedIn) {
      return;
    }

    if (!selectedId) {
      setDetail(null);
      setMessages([]);
      setDetailLoading(false);
      setMessagesLoading(false);
      return;
    }

    setDetail(null);
    setMessages([]);
    void loadDetail(selectedId);
    void loadMessages(selectedId);
  }, [isLoggedIn, loadDetail, loadMessages, selectedId]);

  useEffect(() => {
    if (!isLoggedIn || !selectedId) return;
    if (selectedStatus !== 'approved') return;
    void loadPdfStatus(selectedId, true);
  }, [isLoggedIn, loadPdfStatus, selectedId, selectedStatus]);

  useEffect(() => {
    if (!isLoggedIn || !selectedId) return;
    if (selectedStatus !== 'approved') return;

    const pdfStatus = String(selectedPdf?.status || '').toLowerCase();
    const canDownload = Boolean(selectedPdf?.can_download && selectedPdf?.download_url);
    if (canDownload || pdfStatus === 'failed') {
      return;
    }

    const timer = window.setInterval(() => {
      void loadPdfStatus(selectedId, true);
    }, 15000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isLoggedIn, loadPdfStatus, selectedId, selectedPdf?.can_download, selectedPdf?.download_url, selectedPdf?.status, selectedStatus]);

  useEffect(() => {
    if (!isLoggedIn) {
      clearPulseTimer();
      return;
    }

    let disposed = false;

    const scheduleNext = (): void => {
      if (disposed) {
        return;
      }

      clearPulseTimer();
      const delay = document.hidden ? 60000 : 20000;
      pulseTimerRef.current = window.setTimeout(() => {
        void (async () => {
          await syncPulse();
          if (!disposed) {
            scheduleNext();
          }
        })();
      }, delay);
    };

    const triggerNow = (): void => {
      if (disposed) {
        return;
      }

      clearPulseTimer();
      void (async () => {
        await syncPulse();
        if (!disposed) {
          scheduleNext();
        }
      })();
    };

    const handleVisibility = (): void => {
      if (!document.hidden) {
        triggerNow();
      }
    };

    scheduleNext();
    window.addEventListener('focus', triggerNow);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      disposed = true;
      clearPulseTimer();
      window.removeEventListener('focus', triggerNow);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [clearPulseTimer, isLoggedIn, syncPulse]);

  const handleMessageCreated = useCallback(async (message: MessageItem): Promise<void> => {
    setMessages((current) => mergeNormalizedMessages(current, [message]));
    setPrescriptions((current) => current.map((row) => {
      if (Number(row.id) !== Number(selectedIdRef.current)) {
        return row;
      }

      return {
        ...row,
        last_activity_at: message.created_at,
        message_count: (row.message_count || 0) + 1,
        last_message_seq: typeof message.seq === 'number' ? message.seq : row.last_message_seq,
      };
    }));
    void syncPulse();
  }, [syncPulse]);

  const handleMessageAttachmentDownload = useCallback(
    async (attachmentId: number): Promise<void> => {
      const file = fileIndex[attachmentId];
      const filename = file ? file.original_name : `Fichier #${attachmentId}`;
      const fileUrl = file ? file.download_url : `${cfg.restBase.replace(/\/$/, '')}/files/${attachmentId}/download`;
      await downloadProtectedFile(fileUrl, filename);
    },
    [cfg.restBase, downloadProtectedFile, fileIndex]
  );

  const handlePrescriptionPdfDownload = useCallback(async (prescriptionId: number): Promise<void> => {
    if (prescriptionId < 1) {
      return;
    }

    setPdfDownloadBusyId(prescriptionId);
    setError(null);
    setApiBanner(null);

    try {
      const payload = await getPatientPdfStatus(prescriptionId);
      const banner = resolveBannerFromPayload(payload);
      if (banner) {
        throw new Error(banner);
      }

      const normalized = normalizePdfState(payload);
      setPdfStates((current) => ({
        ...current,
        [prescriptionId]: normalized,
      }));

      const freshUrl = String(normalized.download_url || '').trim();
      const canDownload = Boolean(normalized.can_download && freshUrl !== '');
      if (!canDownload) {
        throw new Error(normalized.last_error_message || normalized.message || 'Le document sécurisé est en cours de préparation.');
      }

      openPresignedPdf(freshUrl);
    } catch (err) {
      const banner = resolveBannerFromError(err);
      if (banner) {
        setApiBanner(banner);
        setError(null);
      } else {
        setError(resolveUnknownErrorMessage(err, 'Le document sécurisé est temporairement indisponible.'));
      }
    } finally {
      setPdfDownloadBusyId((current) => (current === prescriptionId ? null : current));
    }
  }, [getPatientPdfStatus]);

  return {
    prescriptions,
    listLoading,
    selectedId,
    setSelectedId,
    detail,
    detailLoading,
    messages,
    messagesLoading,
    error,
    setError,
    apiBanner,
    pdfStates,
    pdfDownloadBusyId,
    workspace,
    setWorkspace,
    profileSnapshot,
    profileCompletenessResolved,
    selectedSummary,
    profileComplete,
    profileBadgeLabel,
    profileBadgeState,
    paymentProfileSeed,
    paymentBillingName,
    paymentBillingEmail,
    selectedStatus,
    selectedPdf,
    activePayment,
    selectedPaymentPriority,
    requestTitle,
    requestDetails,
    messagingState,
    messagingLocked,
    messagingReadOnlyNotice,
    messagingEmptyText,
    messagingSubtitle,
    messagingDisclosureDefaultOpen,
    messagingDisclosureSummary,
    messagingDisclosureResetKey,
    fileIndex,
    detailDocumentRows,
    detailMedicationRows,
    requestListRows,
    handleProfileChange,
    refreshList,
    loadDetail,
    loadMessages,
    loadPdfStatus,
    syncPulse,
    handleMessageCreated,
    handleMessageAttachmentDownload,
    handlePrescriptionPdfDownload,
  };
}

function normalizeMessageAuthorRole(value: unknown): string {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}
