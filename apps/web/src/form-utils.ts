import { FormEvent } from "react";

export async function handleForm(
  event: FormEvent<HTMLFormElement>,
  action: (form: FormData) => Promise<void> | Promise<unknown>
) {
  event.preventDefault();
  const formElement = event.currentTarget;
  await action(new FormData(formElement));
  formElement.reset();
}
