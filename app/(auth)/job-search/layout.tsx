import type { ReactNode } from 'react';
import { jobSearchMetadata } from '../../../components/job-search/metadata';

export const generateMetadata = () => jobSearchMetadata('search');

export default function JobSearchLayout({ children }: { children: ReactNode }) {
  return children;
}
