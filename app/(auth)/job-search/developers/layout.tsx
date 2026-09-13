import type { ReactNode } from 'react';
import { jobSearchMetadata } from '../../../../components/job-search/metadata';

export const generateMetadata = () => jobSearchMetadata('keys');

export default function JobSearchKeysLayout({ children }: { children: ReactNode }) {
  return children;
}
