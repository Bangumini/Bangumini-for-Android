import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { colors } from "../theme/colors";

export interface DialogButton {
  text: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: () => void;
}

interface DialogOptions {
  title: string;
  message?: string;
  buttons?: DialogButton[];
}

interface DialogContextValue {
  showDialog: (options: DialogOptions) => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [options, setOptions] = useState<DialogOptions>({ title: "" });

  const showDialog = useCallback((opts: DialogOptions) => {
    setOptions(opts);
    setVisible(true);
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
  }, []);

  const handlePress = useCallback(
    (btn: DialogButton) => {
      dismiss();
      btn.onPress?.();
    },
    [dismiss],
  );

  const buttons = options.buttons ?? [{ text: "确定" }];

  return (
    <DialogContext.Provider value={{ showDialog }}>
      {children}
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={dismiss}
      >
        <Pressable style={styles.overlay} onPress={dismiss}>
          <Pressable style={styles.dialog} onPress={() => {}}>
            {options.title ? (
              <Text style={styles.title}>{options.title}</Text>
            ) : null}
            {options.message ? (
              <Text style={styles.message}>{options.message}</Text>
            ) : null}
            <View style={styles.actions}>
              {buttons.map((btn, i) => {
                const isLast = i === buttons.length - 1;
                let textStyle = styles.buttonText;
                if (btn.style === "destructive") {
                  textStyle = styles.buttonTextDanger;
                } else if (btn.style === "cancel") {
                  textStyle = styles.buttonTextCancel;
                }

                return (
                  <Pressable
                    key={i}
                    style={[
                      styles.button,
                      buttons.length > 1 && !isLast && styles.buttonBorder,
                      btn.style === "destructive" && styles.buttonDanger,
                    ]}
                    onPress={() => handlePress(btn)}
                  >
                    <Text style={textStyle}>{btn.text}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error("useDialog must be used within DialogProvider");
  }
  return ctx;
}

export function useAlert() {
  const { showDialog } = useDialog();

  return function alert(
    title: string,
    message?: string,
    buttons?: DialogButton[],
  ) {
    showDialog({ title, message, buttons });
  };
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
  },
  dialog: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: colors.surface,
    borderRadius: 12,
    overflow: "hidden",
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
    paddingTop: 22,
    paddingHorizontal: 22,
  },
  message: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    paddingTop: 8,
    paddingHorizontal: 22,
  },
  actions: {
    marginTop: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    flexDirection: "row",
  },
  button: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 13,
  },
  buttonBorder: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
  },
  buttonDanger: {
    backgroundColor: `${colors.danger}10`,
  },
  buttonText: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: "600",
  },
  buttonTextCancel: {
    color: colors.muted,
    fontSize: 16,
    fontWeight: "600",
  },
  buttonTextDanger: {
    color: colors.danger,
    fontSize: 16,
    fontWeight: "600",
  },
});
