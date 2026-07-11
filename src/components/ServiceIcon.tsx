import type { CSSProperties } from "react";
import {
  Package,
  Truck,
  Warehouse,
  Boxes,
  CreditCard,
  Landmark,
  Code2,
  Handshake,
  Undo2,
  PackageSearch,
  type LucideIcon,
} from "lucide-react";

const ICON_MAP: Record<string, LucideIcon> = {
  shipping: Package,
  cargo: Truck,
  fulfillment: Boxes,
  wms: Warehouse,
  "ecart-pay": CreditCard,
  "ecart-banking": Landmark,
  "ecart-api": Code2,
  partners: Handshake,
  returns: Undo2,
  parapaquetes: PackageSearch,
};

type ServiceIconProps = {
  icon: string;
  className?: string;
  style?: CSSProperties;
};

export function ServiceIcon({ icon, className, style }: ServiceIconProps) {
  const Icon = ICON_MAP[icon] ?? Package;
  return <Icon className={className} style={style} />;
}

export function ServiceInitial({ name }: { name: string }) {
  return name.charAt(0).toUpperCase();
}
