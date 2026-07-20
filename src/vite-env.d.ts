/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TENDENCYS_BASE_URL: string;
  readonly VITE_SHELL_SITE_ID: string;
  readonly VITE_ENVIA_SHIPPING_URL: string;
  readonly VITE_ENVIA_SHIPPING_SITE_ID: string;
  readonly VITE_ENVIA_CARGO_URL: string;
  readonly VITE_ENVIA_CARGO_SITE_ID: string;
  readonly VITE_ENVIA_FULFILLMENT_URL: string;
  readonly VITE_ENVIA_FULFILLMENT_SITE_ID: string;
  readonly VITE_ENVIA_WMS_URL: string;
  readonly VITE_ENVIA_WMS_SITE_ID: string;
  readonly VITE_ECART_PAY_URL: string;
  readonly VITE_ECART_PAY_SITE_ID: string;
  readonly VITE_ECART_BANKING_URL: string;
  readonly VITE_ECART_BANKING_SITE_ID: string;
  readonly VITE_ECART_API_URL: string;
  readonly VITE_ECART_API_SITE_ID: string;
  readonly VITE_ENVIA_DOCS_URL: string;
  readonly VITE_ECART_API_DOCS_URL: string;
  readonly VITE_ENVIA_FULFILLMENT_DOCS_URL: string;
  readonly VITE_ECART_PAY_DOCS_URL: string;
  readonly VITE_ENVIA_CARGO_DOCS_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
