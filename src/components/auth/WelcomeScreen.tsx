import { ShieldCheck } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ServiceShowcase } from "@/components/auth/ServiceShowcase";
import accountsLogo from "@/assets/logos/accounts-logo.svg";

type WelcomeScreenProps = {
  onSignIn: () => void;
  onCreateAccount: () => void;
};

/**
 * Branded landing state shown when there is no session and no usable device
 * key — invites the visitor to sign in or create an account instead of being
 * dropped straight into the Accounts webview. Purely presentational; all
 * session/auth logic lives in LoginPage.
 */
export function WelcomeScreen({ onSignIn, onCreateAccount }: WelcomeScreenProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();

  return (
    <div className="flex h-screen bg-white">
      <div className="flex w-full flex-col items-center justify-center px-8 md:w-[440px] md:shrink-0">
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="flex w-full max-w-sm flex-col gap-6"
        >
          <img src={accountsLogo} alt="Tendencys" className="h-8 w-auto" />
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold leading-tight text-foreground">
              {t("welcome.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("welcome.subtitle")}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Button className="w-full" onClick={onSignIn}>
              {t("welcome.signIn")}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={onCreateAccount}
            >
              {t("welcome.createAccount")}
            </Button>
          </div>
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("welcome.secureNote")}</span>
          </div>
        </motion.div>
      </div>
      <ServiceShowcase />
    </div>
  );
}
