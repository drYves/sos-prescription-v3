// DoctorMessagingApp.tsx · V9.9.0-alpha1
import React from 'react';
import useDoctorMessagingSurface from './doctorMessaging/useDoctorMessagingSurface';
import MessageThread from './messaging/MessageThread';

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function Notice({
  variant = 'info',
  children,
}: {
  variant?: 'info' | 'success' | 'warning' | 'error';
  children: React.ReactNode;
}) {
  return <div className={cx('sp-alert', `sp-alert--${variant}`)}>{children}</div>;
}

export default function DoctorMessagingApp({ prescriptionId }: { prescriptionId: number }) {
  const {
    surfaceRef,
    flash,
    surfaceError,
    threadSurfaceError,
    assistantSurfaceError,
    modeNotice,
    messageThreadProps,
  } = useDoctorMessagingSurface({ prescriptionId });

  return (
    <div ref={surfaceRef} className="sp-card dc-message-react-panel">
      {flash ? <Notice variant="success">{flash}</Notice> : null}
      {surfaceError ? <Notice variant="error">{surfaceError}</Notice> : null}
      {threadSurfaceError ? <Notice variant="error">{threadSurfaceError}</Notice> : null}
      {assistantSurfaceError ? <Notice variant="warning">{assistantSurfaceError}</Notice> : null}
      {modeNotice ? <Notice variant="info">{modeNotice}</Notice> : null}

      <div className="sp-top-gap">
        <MessageThread {...messageThreadProps} />
      </div>
    </div>
  );
}
