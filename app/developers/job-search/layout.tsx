import type { ReactNode } from 'react';
import { jobSearchMetadata } from '../../../components/job-search/metadata';

export const generateMetadata = () => jobSearchMetadata('api');

export default function JobSearchApiLayout({ children }: { children: ReactNode }) {
  return children;
}
