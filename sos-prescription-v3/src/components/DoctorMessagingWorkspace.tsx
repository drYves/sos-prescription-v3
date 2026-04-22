import React from 'react';
import DoctorMessagingApp from './DoctorMessagingApp';

type DoctorMessagingWorkspaceProps = {
  prescriptionId: number;
};

export default function DoctorMessagingWorkspace({ prescriptionId }: DoctorMessagingWorkspaceProps) {
  return <DoctorMessagingApp prescriptionId={prescriptionId} />;
}
