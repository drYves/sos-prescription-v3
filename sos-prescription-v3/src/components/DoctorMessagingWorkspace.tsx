import React from 'react';
import DoctorMessagingApp from './DoctorMessagingApp';
import { useDoctorMessagingContext } from './doctorMessaging/DoctorMessagingProvider';

export default function DoctorMessagingWorkspace() {
  useDoctorMessagingContext();
  return <DoctorMessagingApp />;
}
