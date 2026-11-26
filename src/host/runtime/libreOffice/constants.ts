import { PROBE_SLOW_TTFB_MS, PROBE_TIMEOUT_MS } from '../pythonEnv/constants';

export const LIBREOFFICE_RUNTIME_VERSION = '26.2.7';
const LIBREOFFICE_OFFICIAL_BASE = 'https://download.documentfoundation.org/libreoffice/stable/26.2.7/mac';
const LIBREOFFICE_MIRROR_BASE = 'https://mirrors.ustc.edu.cn/tdf/libreoffice/stable/26.2.7/mac';
export const LIBREOFFICE_RUNTIME_ASSET_ID = 'libreoffice';
export const LIBREOFFICE_RUNTIME_LABEL = 'LibreOffice document renderer';
export const LIBREOFFICE_ROOT_NAME = 'libreoffice';
export const LIBREOFFICE_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;
export const LIBREOFFICE_PROBE_SLOW_TTFB_MS = PROBE_SLOW_TTFB_MS;

export interface LibreOfficeBuild {
  arch: 'arm64' | 'x86_64';
  fileName: string;
  officialUrl: string;
  mirrorUrl: string;
  sha256: string;
  bytes: number;
}

const ARM64_FILE = 'LibreOffice_26.2.7_MacOS_aarch64.dmg';
const X64_FILE = 'LibreOffice_26.2.7_MacOS_x86-64.dmg';

const LIBREOFFICE_BUILDS: Record<'arm64' | 'x86_64', LibreOfficeBuild> = {
  arm64: {
    arch: 'arm64',
    fileName: ARM64_FILE,
    officialUrl: `${LIBREOFFICE_OFFICIAL_BASE}/aarch64/${ARM64_FILE}`,
    mirrorUrl: `${LIBREOFFICE_MIRROR_BASE}/aarch64/${ARM64_FILE}`,
    sha256: '58601808ae2b919c82dc7c4d6a26389de0e167f344ca48e5b6c9189218eb95ae',
    bytes: 297813809,
  },
  x86_64: {
    arch: 'x86_64',
    fileName: X64_FILE,
    officialUrl: `${LIBREOFFICE_OFFICIAL_BASE}/x86_64/${X64_FILE}`,
    mirrorUrl: `${LIBREOFFICE_MIRROR_BASE}/x86_64/${X64_FILE}`,
    sha256: '26a830205c617cc624b2a83783ef46434a4d6c337c3a873f79c43012171f83de',
    bytes: 308070986,
  },
};

export function buildForArch(arch: string = process.arch): LibreOfficeBuild {
  return arch === 'arm64' ? LIBREOFFICE_BUILDS.arm64 : LIBREOFFICE_BUILDS.x86_64;
}
