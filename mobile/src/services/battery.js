import { NativeModules, Platform } from 'react-native';

const Mod = NativeModules.TojeyBattery;

const rawManufacturer = (Mod && Mod.manufacturer ? String(Mod.manufacturer) : '').toLowerCase();
const rawModel = (Mod && Mod.model ? String(Mod.model) : '');
const sdkInt = Mod && Mod.androidVersion ? Number(Mod.androidVersion) : (Platform.Version || 0);

export function supportsBatteryModule() {
  return Platform.OS === 'android' && !!Mod;
}

// Best-effort OEM detection from the real hardware manufacturer (native Build infos).
export function getDeviceInfo() {
  const m = rawManufacturer;
  let brand = 'GENERIC';
  let label = 'Android';
  if (/oneplus/.test(m)) {
    brand = 'ONEPLUS';
    label = 'OnePlus (OxygenOS)';
  } else if (/realme/.test(m)) {
    brand = 'REALME';
    label = 'realme (realme UI)';
  } else if (/oppo/.test(m)) {
    brand = 'OPPO';
    label = 'OPPO (ColorOS)';
  } else if (/vivo/.test(m)) {
    brand = 'VIVO';
    label = 'vivo (Funtouch OS)';
  } else if (/xiaomi|redmi|poco/.test(m)) {
    brand = 'XIAOMI';
    label = 'Xiaomi / Redmi / POCO (MIUI)';
  } else if (/samsung/.test(m)) {
    brand = 'SAMSUNG';
    label = 'Samsung (One UI)';
  } else if (/honor/.test(m)) {
    brand = 'HONOR';
    label = 'Honor (Magic UI)';
  } else if (/huawei/.test(m)) {
    brand = 'HUAWEI';
    label = 'Huawei (EMUI)';
  } else if (/asus/.test(m)) {
    brand = 'ASUS';
    label = 'ASUS (Zen UI)';
  } else if (/tecno|infinix|itel/.test(m)) {
    brand = 'TRANSSION';
    label = 'Tecno / Infinix / iTel';
  } else if (/nokia/.test(m)) {
    brand = 'NOKIA';
    label = 'Nokia (Android One)';
  }
  return { brand, label, manufacturer: rawManufacturer, model: rawModel, sdkInt };
}

// OEMs with notorious background/battery killers that block push delivery for
// apps not on their auto-start / "protected" allowlist.
export function isAggressiveOem() {
  return ['OPPO', 'REALME', 'VIVO', 'XIAOMI', 'HUAWEI', 'HONOR', 'TRANSSION'].includes(getDeviceInfo().brand);
}

export async function isBatteryOptimizationIgnored() {
  try {
    if (!supportsBatteryModule()) return true;
    return !!(await Mod.isIgnoringBatteryOptimizations());
  } catch (e) {
    return false;
  }
}

export function requestBatteryOptimizationExempt() {
  try {
    if (supportsBatteryModule()) Mod.requestIgnoreBatteryOptimizations();
  } catch (e) {}
}