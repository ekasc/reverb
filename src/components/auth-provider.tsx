import { apiJson } from "@/lib/api";
import { MeSchema, type Me } from "@shared/api";
import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import { z } from "zod";

type AuthContextValue = {
	me: Me["user"] | null;
	loading: boolean;
	refresh: () => Promise<void>;
	logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider(props: { children: ReactNode }) {
	const [me, setMe] = useState<Me["user"] | null>(null);
	const [loading, setLoading] = useState(true);

	const refresh = async () => {
		try {
			const resp = await apiJson("/api/me", {}, MeSchema);
			setMe(resp.user);
		} catch {
			setMe(null);
		} finally {
			setLoading(false);
		}
	};

	const logout = async () => {
		try {
			await apiJson("/api/logout", { method: "POST" }, z.any());
		} finally {
			setMe(null);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const value = useMemo(() => ({ me, loading, refresh, logout }), [me, loading]);

	return <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>;
}

export function useAuth() {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth must be used within AuthProvider");
	return ctx;
}
