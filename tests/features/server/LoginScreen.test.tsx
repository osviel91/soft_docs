import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LoginScreen from "../../../src/features/server/LoginScreen";
import type { AuthHook } from "../../../src/features/server/use-auth";

function auth(overrides: Partial<AuthHook> = {}): AuthHook {
  return {
    status: "anonymous",
    user: null,
    signIn: vi.fn(),
    signInLocal: vi.fn().mockResolvedValue(undefined),
    registerLocal: vi.fn().mockResolvedValue("Awaiting approval"),
    signOut: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("LoginScreen", () => {
  it("explains an account awaiting approval after Google sign-in", () => {
    window.history.replaceState({}, "", "/?auth=pending");
    render(<LoginScreen auth={auth()} />);
    expect(screen.getByTestId("login-account-status")).toHaveTextContent(
      "awaiting administrator approval",
    );
  });

  it("offers local registration and Google without rendering the app", async () => {
    const currentAuth = auth();
    render(<LoginScreen auth={currentAuth} />);

    expect(screen.getByTestId("login-page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create a local account" }));
    fireEvent.change(screen.getByTestId("login-display-name"), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByTestId("login-email"), {
      target: { value: "ada@example.test" },
    });
    fireEvent.change(screen.getByTestId("login-password"), {
      target: { value: "a-secure-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(currentAuth.registerLocal).toHaveBeenCalledWith(
        "ada@example.test",
        "a-secure-password-123",
        "Ada",
      ),
    );
    expect(await screen.findByTestId("login-message")).toHaveTextContent(
      "Awaiting approval",
    );
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.queryByText("Invitation code")).toBeNull();
  });

  it("redeems a recovery token from the URL fragment without showing it to the server", async () => {
    window.history.replaceState({}, "", "/#reset=one-time-code");
    const currentAuth = auth({ redeemPasswordRecovery: vi.fn().mockResolvedValue(undefined) });
    render(<LoginScreen auth={currentAuth} />);
    expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeInTheDocument();
    expect(screen.queryByTestId("login-email")).toBeNull();
    fireEvent.change(screen.getByTestId("login-password"), {
      target: { value: "replacement-password-456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    await waitFor(() => expect(currentAuth.redeemPasswordRecovery).toHaveBeenCalledWith(
      "one-time-code",
      "replacement-password-456",
    ));
    expect(await screen.findByTestId("login-message")).toHaveTextContent("Password updated");
    expect(window.location.hash).toBe("");
  });
});
