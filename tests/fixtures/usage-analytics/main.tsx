import React from "react";
import "../../../app/globals.css";
import {createRoot} from "react-dom/client";
import {AdminUsersPageBoundary} from "../../../app/admin/users/admin-users-page";
createRoot(document.getElementById("root")!).render(<AdminUsersPageBoundary/>);
